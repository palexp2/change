import { Router } from 'express'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { newRecordId } from '../utils/recordId.js'
import {
  hydrateType, ownerStatus, slugify, validTimezone, DEFAULT_AVAILABILITY, LOCATION_TYPES,
  getBooking, cancelBooking, manageUrl,
} from '../services/meetings.js'
import { APP_URL } from '../config/appUrl.js'

// Marketing → Rendez-vous : pages de réservation et réservations reçues.
// API publique (visiteur) : routes/meetings-public.js.

const router = Router()
router.use(requireAuth)

const TYPE_LIST_SELECT = `
  SELECT t.*, u.name AS owner_name,
    (SELECT COUNT(*) FROM meeting_bookings b WHERE b.meeting_type_id=t.id AND b.status='confirmed' AND b.start_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) AS upcoming_count,
    (SELECT COUNT(*) FROM meeting_bookings b WHERE b.meeting_type_id=t.id) AS booking_count
  FROM meeting_types t LEFT JOIN users u ON u.id=t.owner_user_id`

const BOOKING_LIST_SELECT = `
  SELECT b.*, t.name AS type_name, t.slug, u.name AS owner_name,
    TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')) AS contact_name
  FROM meeting_bookings b
  LEFT JOIN meeting_types t ON t.id=b.meeting_type_id
  LEFT JOIN users u ON u.id=b.owner_user_id
  LEFT JOIN contacts c ON c.id=b.contact_id`

function publicUrl(slug) { return `${APP_URL}/erp/rdv/${slug}` }

function typeView(row) {
  const t = hydrateType(row)
  return { ...t, public_url: publicUrl(t.slug), ...ownerStatus(t.owner_user_id) }
}

function bookingView(b) {
  const { manage_token, ...rest } = b
  return { ...rest, manage_url: manageUrl({ manage_token }) }
}

function uniqueSlug(base, exceptId = null) {
  const root = slugify(base) || 'rendez-vous'
  let slug = root
  for (let i = 2; db.prepare('SELECT 1 FROM meeting_types WHERE slug=? AND id IS NOT ?').get(slug, exceptId); i++) slug = `${root}-${i}`
  return slug
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

function cleanAvailability(v) {
  if (!v || typeof v !== 'object') throw new Error('Plages invalides')
  const out = {}
  for (const [day, wins] of Object.entries(v)) {
    if (!/^[0-6]$/.test(day) || !Array.isArray(wins)) continue
    const ok = wins.filter(w => Array.isArray(w) && TIME_RE.test(w[0]) && TIME_RE.test(w[1]) && w[0] < w[1])
    if (ok.length) out[day] = ok.map(([a, b]) => [a, b])
  }
  return out
}

function cleanMinutesList(v, label) {
  if (!Array.isArray(v)) throw new Error(`${label} invalides`)
  return [...new Set(v.map(Number).filter(n => Number.isInteger(n) && n > 0 && n <= 60 * 24 * 30))].sort((a, b) => a - b)
}

// Champ → normaliseur. Toute clé absente est refusée en silence.
const WRITABLE = {
  name: v => { const s = String(v || '').trim(); if (!s) throw new Error('Nom requis'); return s.slice(0, 120) },
  description: v => (v == null ? null : String(v).slice(0, 4000)),
  owner_user_id: v => {
    if (!v) return null
    if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(v)) throw new Error('Utilisateur introuvable')
    return v
  },
  durations: v => { const d = cleanMinutesList(v, 'Durées'); if (!d.length) throw new Error('Au moins une durée'); return JSON.stringify(d) },
  availability: v => JSON.stringify(cleanAvailability(v)),
  timezone: v => { if (!validTimezone(v)) throw new Error('Fuseau invalide'); return v },
  slot_interval: v => Math.min(240, Math.max(5, Number(v) || 30)),
  buffer_before: v => Math.min(240, Math.max(0, Number(v) || 0)),
  buffer_after: v => Math.min(240, Math.max(0, Number(v) || 0)),
  min_notice_hours: v => Math.min(24 * 30, Math.max(0, Number(v) || 0)),
  max_days_ahead: v => Math.min(365, Math.max(1, Number(v) || 30)),
  location_type: v => { if (!LOCATION_TYPES.includes(v)) throw new Error('Lieu invalide'); return v },
  location: v => (v == null ? null : String(v).slice(0, 500)),
  reminders: v => JSON.stringify(cleanMinutesList(v, 'Rappels')),
  language: v => (v === 'en' ? 'en' : 'fr'),
  active: v => (v ? 1 : 0),
}

// GET /api/meetings/types
router.get('/types', (req, res) => {
  res.json(db.prepare(`${TYPE_LIST_SELECT} ORDER BY t.name`).all().map(typeView))
})

// POST /api/meetings/types
router.post('/types', (req, res) => {
  const name = String(req.body?.name || '').trim()
  if (!name) return res.status(400).json({ error: 'Nom requis' })
  const id = newRecordId()
  db.prepare(`
    INSERT INTO meeting_types (id, name, slug, owner_user_id, durations, availability, description)
    VALUES (?,?,?,?,?,?,?)
  `).run(id, name.slice(0, 120), uniqueSlug(req.body?.slug || name), req.body?.owner_user_id || req.user.id,
    JSON.stringify(cleanMinutesList(req.body?.durations || [30], 'Durées')), JSON.stringify(DEFAULT_AVAILABILITY),
    req.body?.description || null)
  res.status(201).json(typeView(db.prepare(`${TYPE_LIST_SELECT} WHERE t.id=?`).get(id)))
})

// GET /api/meetings/types/:id — page + ses réservations
router.get('/types/:id', (req, res) => {
  const row = db.prepare(`${TYPE_LIST_SELECT} WHERE t.id=?`).get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Page introuvable' })
  const bookings = db.prepare(`${BOOKING_LIST_SELECT} WHERE b.meeting_type_id=? ORDER BY b.start_at DESC`).all(req.params.id)
  res.json({ ...typeView(row), bookings: bookings.map(bookingView) })
})

// PATCH /api/meetings/types/:id
router.patch('/types/:id', (req, res) => {
  if (!db.prepare('SELECT 1 FROM meeting_types WHERE id=?').get(req.params.id)) return res.status(404).json({ error: 'Page introuvable' })
  const sets = {}
  try {
    for (const [k, v] of Object.entries(req.body || {})) {
      if (k === 'slug') {
        const s = slugify(v)
        if (!s) throw new Error('Lien invalide')
        if (db.prepare('SELECT 1 FROM meeting_types WHERE slug=? AND id<>?').get(s, req.params.id)) throw new Error('Lien déjà pris')
        sets.slug = s
      } else if (WRITABLE[k]) sets[k] = WRITABLE[k](v)
    }
  } catch (e) { return res.status(400).json({ error: e.message }) }
  if (Object.keys(sets).length) {
    const cols = Object.keys(sets).map(k => `${k}=@${k}`).join(', ')
    db.prepare(`UPDATE meeting_types SET ${cols}, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=@id`).run({ ...sets, id: req.params.id })
  }
  res.json(typeView(db.prepare(`${TYPE_LIST_SELECT} WHERE t.id=?`).get(req.params.id)))
})

// DELETE /api/meetings/types/:id — les réservations restent (meeting_type_id → NULL)
router.delete('/types/:id', (req, res) => {
  const r = db.prepare('DELETE FROM meeting_types WHERE id=?').run(req.params.id)
  if (!r.changes) return res.status(404).json({ error: 'Page introuvable' })
  res.json({ ok: true })
})

// GET /api/meetings/bookings
router.get('/bookings', (req, res) => {
  res.json(db.prepare(`${BOOKING_LIST_SELECT} ORDER BY b.start_at DESC LIMIT 2000`).all().map(bookingView))
})

// POST /api/meetings/bookings/:id/cancel — annulation côté Orisha
router.post('/bookings/:id/cancel', async (req, res) => {
  const b = getBooking(req.params.id)
  if (!b) return res.status(404).json({ error: 'Réservation introuvable' })
  const r = await cancelBooking(b, req.user.name || 'orisha')
  res.json(bookingView(r.booking))
})

export default router
