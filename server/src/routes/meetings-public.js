// Prise de rendez-vous — API PUBLIQUE des pages /rdv/:slug et
// /rdv/gestion/:token. Pas de requireAuth : le visiteur n'a pas de compte.
// Le slug d'une page active est public par nature ; le jeton de gestion d'une
// réservation est son secret (18 octets aléatoires). Rien ne fuit de l'agenda
// du propriétaire : seuls des créneaux libres sortent.

import { Router } from 'express'
import {
  getTypeBySlug, availableSlots, createBooking, getBookingByToken, rescheduleBooking, cancelBooking,
  hydrateType, ownerStatus,
} from '../services/meetings.js'
import db from '../db/database.js'

const router = Router()

function publicType(t) {
  return {
    name: t.name, slug: t.slug, description: t.description, durations: t.durations, timezone: t.timezone,
    location_type: t.location_type, location: t.location_type === 'place' ? t.location : null,
    language: t.language, owner_name: ownerStatus(t.owner_user_id).owner_name,
  }
}

function publicBooking(b) {
  return {
    start_at: b.start_at, end_at: b.end_at, duration_minutes: b.duration_minutes, status: b.status,
    invitee_name: b.invitee_name, meet_url: b.meet_url, owner_name: b.owner_name,
  }
}

function activeType(slug) {
  const t = getTypeBySlug(slug)
  return t?.active ? t : null
}

// GET /api/public/meetings/booking/:token — déclaré avant /:slug
router.get('/booking/:token', (req, res) => {
  const b = getBookingByToken(req.params.token)
  if (!b) return res.status(404).json({ error: 'Rendez-vous introuvable' })
  const t = hydrateType(db.prepare('SELECT * FROM meeting_types WHERE id=?').get(b.meeting_type_id))
  res.json({ booking: publicBooking(b), type: t ? publicType(t) : null })
})

// GET /api/public/meetings/booking/:token/slots — créneaux pour déplacer
router.get('/booking/:token/slots', async (req, res) => {
  const b = getBookingByToken(req.params.token)
  if (!b || b.status !== 'confirmed') return res.status(404).json({ error: 'Rendez-vous introuvable' })
  const t = hydrateType(db.prepare('SELECT * FROM meeting_types WHERE id=?').get(b.meeting_type_id))
  if (!t) return res.status(404).json({ error: 'Rendez-vous introuvable' })
  const { slots } = await availableSlots(t, b.duration_minutes, { exceptBookingId: b.id })
  res.json({ slots: slots.map(s => new Date(s).toISOString()) })
})

// POST /api/public/meetings/booking/:token/reschedule — { start }
router.post('/booking/:token/reschedule', async (req, res) => {
  const b = getBookingByToken(req.params.token)
  if (!b) return res.status(404).json({ error: 'Rendez-vous introuvable' })
  const r = await rescheduleBooking(b, req.body?.start)
  if (!r.ok) return res.status(r.status).json({ error: r.error })
  res.json({ booking: publicBooking(r.booking) })
})

// POST /api/public/meetings/booking/:token/cancel
router.post('/booking/:token/cancel', async (req, res) => {
  const b = getBookingByToken(req.params.token)
  if (!b) return res.status(404).json({ error: 'Rendez-vous introuvable' })
  const r = await cancelBooking(b, 'invitee')
  res.json({ booking: publicBooking(r.booking) })
})

// GET /api/public/meetings/:slug
router.get('/:slug', (req, res) => {
  const t = activeType(req.params.slug)
  if (!t) return res.status(404).json({ error: 'Page introuvable' })
  res.json(publicType(t))
})

// GET /api/public/meetings/:slug/slots?duration=30
router.get('/:slug/slots', async (req, res) => {
  const t = activeType(req.params.slug)
  if (!t) return res.status(404).json({ error: 'Page introuvable' })
  const duration = Number(req.query.duration) || t.durations[0]
  if (!t.durations.includes(duration)) return res.status(400).json({ error: 'Durée invalide' })
  const { slots } = await availableSlots(t, duration)
  res.json({ slots: slots.map(s => new Date(s).toISOString()) })
})

// POST /api/public/meetings/:slug/book
router.post('/:slug/book', async (req, res) => {
  const t = activeType(req.params.slug)
  if (!t) return res.status(404).json({ error: 'Page introuvable' })
  // Pot de miel : champ invisible qu'un humain ne remplit jamais.
  if (req.body?.website) return res.status(400).json({ error: 'Requête refusée' })
  const r = await createBooking(t, req.body || {})
  if (!r.ok) return res.status(r.status).json({ error: r.error })
  res.status(201).json({ booking: publicBooking(r.booking), manage_token: r.booking.manage_token })
})

export default router
