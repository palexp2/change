import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { parseDurationToMinutes } from '../services/duration.js'

const router = Router()
router.use(requireAuth)

const ALLOWED_MODES = new Set(['simple', 'detailed'])

// Admin (role='admin') peut voir/modifier toutes les feuilles. Sinon, restreint à l'utilisateur connecté.
function resolveTargetUserId(req, requested) {
  const me = req.user
  if (!requested || requested === me.id) return me.id
  if (me.role === 'admin') return requested
  return null // not allowed
}

function loadDayWithEntries(id) {
  const day = db.prepare('SELECT * FROM timesheet_days WHERE id = ? AND deleted_at IS NULL').get(id)
  if (!day) return null
  const entries = db.prepare(`
    SELECT e.*, ac.name as activity_code_name, ac.payable as activity_code_payable, c.name as company_name
    FROM timesheet_entries e
    LEFT JOIN activity_codes ac ON e.activity_code_id = ac.id
    LEFT JOIN companies c ON e.company_id = c.id
    WHERE day_id = ?
    ORDER BY sort_order ASC, created_at ASC
  `).all(id)
  return { ...day, entries }
}

// GET /api/timesheets?user_id=X&from=YYYY-MM-DD&to=YYYY-MM-DD
// Liste les jours avec leurs entrées sur une plage (inclusive).
router.get('/', (req, res) => {
  const target = resolveTargetUserId(req, req.query.user_id)
  if (!target) return res.status(403).json({ error: 'Accès refusé' })

  const { from, to } = req.query
  let where = 'WHERE deleted_at IS NULL AND user_id = ?'
  const params = [target]
  if (from) { where += ' AND date >= ?'; params.push(from) }
  if (to) { where += ' AND date <= ?'; params.push(to) }

  const days = db.prepare(`SELECT * FROM timesheet_days ${where} ORDER BY date DESC`).all(...params)
  const result = days.map(d => {
    const entries = db.prepare(`
      SELECT e.*, ac.name as activity_code_name, ac.payable as activity_code_payable, c.name as company_name
      FROM timesheet_entries e
      LEFT JOIN activity_codes ac ON e.activity_code_id = ac.id
      LEFT JOIN companies c ON e.company_id = c.id
      WHERE day_id = ?
      ORDER BY sort_order ASC, created_at ASC
    `).all(d.id)
    return { ...d, entries }
  })
  res.json({ data: result })
})

// GET /api/timesheets/day?user_id=X&date=YYYY-MM-DD  (upsert-style: ne crée pas si absent)
router.get('/day', (req, res) => {
  const target = resolveTargetUserId(req, req.query.user_id)
  if (!target) return res.status(403).json({ error: 'Accès refusé' })
  const { date } = req.query
  if (!date) return res.status(400).json({ error: 'date requis' })

  const day = db.prepare('SELECT * FROM timesheet_days WHERE user_id = ? AND date = ? AND deleted_at IS NULL').get(target, date)
  if (!day) return res.json(null)
  res.json(loadDayWithEntries(day.id))
})

// GET /api/timesheets/preferences — préférences de l'utilisateur courant (mode par défaut)
router.get('/preferences', (req, res) => {
  const row = db.prepare('SELECT timesheet_default_mode FROM users WHERE id = ?').get(req.user.id)
  const mode = row?.timesheet_default_mode
  res.json({ default_mode: ALLOWED_MODES.has(mode) ? mode : 'simple' })
})

// PATCH /api/timesheets/preferences — maj explicite du mode par défaut
router.patch('/preferences', (req, res) => {
  const { default_mode } = req.body || {}
  if (!ALLOWED_MODES.has(default_mode)) return res.status(400).json({ error: 'default_mode invalide' })
  db.prepare('UPDATE users SET timesheet_default_mode = ? WHERE id = ?').run(default_mode, req.user.id)
  res.json({ default_mode })
})

// POST /api/timesheets/day — crée (ou retourne l'existant) le jour pour (user_id, date)
router.post('/day', (req, res) => {
  const target = resolveTargetUserId(req, req.body.user_id)
  if (!target) return res.status(403).json({ error: 'Accès refusé' })
  const { date } = req.body || {}
  let { mode } = req.body || {}
  if (!date) return res.status(400).json({ error: 'date requis' })
  // Si aucun mode fourni, défaut = préférence de l'utilisateur cible
  if (!mode) {
    const row = db.prepare('SELECT timesheet_default_mode FROM users WHERE id = ?').get(target)
    mode = ALLOWED_MODES.has(row?.timesheet_default_mode) ? row.timesheet_default_mode : 'simple'
  }
  if (!ALLOWED_MODES.has(mode)) return res.status(400).json({ error: 'mode invalide' })

  const existing = db.prepare('SELECT id FROM timesheet_days WHERE user_id = ? AND date = ? AND deleted_at IS NULL').get(target, date)
  if (existing) return res.json(loadDayWithEntries(existing.id))

  const id = uuidv4()
  db.prepare(`
    INSERT INTO timesheet_days (id, user_id, date, mode)
    VALUES (?, ?, ?, ?)
  `).run(id, target, date, mode)
  // Synchronise la pref uniquement si le user agit sur sa propre journée
  if (req.user.id === target) {
    db.prepare('UPDATE users SET timesheet_default_mode = ? WHERE id = ?').run(mode, req.user.id)
  }
  res.status(201).json(loadDayWithEntries(id))
})

const DAY_PATCHABLE = new Set(['mode', 'start_time', 'end_time', 'break_minutes'])

// PATCH /api/timesheets/day/:id
router.patch('/day/:id', (req, res) => {
  const day = db.prepare('SELECT * FROM timesheet_days WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!day) return res.status(404).json({ error: 'Not found' })
  const target = resolveTargetUserId(req, day.user_id)
  if (!target) return res.status(403).json({ error: 'Accès refusé' })

  const updates = []
  const params = []
  for (const [k, rawV] of Object.entries(req.body || {})) {
    if (!DAY_PATCHABLE.has(k)) continue
    let v = rawV
    if (v === '' || v === undefined) v = null
    if (k === 'mode' && v !== null && !ALLOWED_MODES.has(v)) {
      return res.status(400).json({ error: 'mode invalide' })
    }
    if (k === 'mode' && v === 'simple' && day.mode === 'detailed') {
      const { n } = db.prepare('SELECT COUNT(*) AS n FROM timesheet_entries WHERE day_id = ?').get(day.id)
      if (n > 0) {
        return res.status(409).json({ error: 'Impossible de basculer en mode simplifié : la journée contient des activités détaillées. Supprimez-les d\'abord.' })
      }
    }
    if (k === 'break_minutes' && v !== null) {
      const n = parseDurationToMinutes(v)
      if (n == null) return res.status(400).json({ error: 'break_minutes invalide' })
      v = n
    }
    updates.push(`${k} = ?`)
    params.push(v)
  }
  if (!updates.length) return res.status(400).json({ error: 'Aucun champ modifiable fourni' })
  updates.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
  params.push(req.params.id)
  db.prepare(`UPDATE timesheet_days SET ${updates.join(', ')} WHERE id = ?`).run(...params)
  // Si le user change le mode de SA propre journée, on mémorise cette préférence.
  if (req.body && typeof req.body.mode === 'string' && ALLOWED_MODES.has(req.body.mode) && req.user.id === day.user_id) {
    db.prepare('UPDATE users SET timesheet_default_mode = ? WHERE id = ?').run(req.body.mode, req.user.id)
  }
  res.json(loadDayWithEntries(req.params.id))
})

// DELETE /api/timesheets/day/:id — soft delete (aligné avec le reste de l'app)
router.delete('/day/:id', (req, res) => {
  const day = db.prepare('SELECT user_id FROM timesheet_days WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!day) return res.status(404).json({ error: 'Not found' })
  if (!resolveTargetUserId(req, day.user_id)) return res.status(403).json({ error: 'Accès refusé' })
  db.prepare(`UPDATE timesheet_days SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(req.params.id)
  res.json({ success: true })
})

// POST /api/timesheets/day/:dayId/entries — ajoute une activité
router.post('/day/:dayId/entries', (req, res) => {
  const day = db.prepare('SELECT user_id FROM timesheet_days WHERE id = ? AND deleted_at IS NULL').get(req.params.dayId)
  if (!day) return res.status(404).json({ error: 'Day not found' })
  if (!resolveTargetUserId(req, day.user_id)) return res.status(403).json({ error: 'Accès refusé' })

  const { description, activity_code_id, company_id, duration, duration_minutes, rsde, sort_order } = req.body || {}
  const mins = duration_minutes != null
    ? parseInt(duration_minutes, 10) || 0
    : (parseDurationToMinutes(duration) || 0)

  // sort_order par défaut = max + 1 dans la journée
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 as next FROM timesheet_entries WHERE day_id = ?').get(req.params.dayId).next
  const id = uuidv4()
  db.prepare(`
    INSERT INTO timesheet_entries (id, day_id, sort_order, description, activity_code_id, company_id, duration_minutes, rsde)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    req.params.dayId,
    sort_order != null ? parseInt(sort_order, 10) : maxOrder,
    description || null,
    activity_code_id || null,
    company_id || null,
    mins,
    rsde ? 1 : 0,
  )
  res.status(201).json(loadDayWithEntries(req.params.dayId))
})

const ENTRY_PATCHABLE = new Set(['description', 'activity_code_id', 'company_id', 'duration_minutes', 'rsde', 'sort_order'])

// PATCH /api/timesheets/entries/:id — met à jour une activité
router.patch('/entries/:id', (req, res) => {
  const entry = db.prepare(`
    SELECT e.*, d.user_id
    FROM timesheet_entries e
    JOIN timesheet_days d ON e.day_id = d.id
    WHERE e.id = ? AND d.deleted_at IS NULL
  `).get(req.params.id)
  if (!entry) return res.status(404).json({ error: 'Not found' })
  if (!resolveTargetUserId(req, entry.user_id)) return res.status(403).json({ error: 'Accès refusé' })

  const updates = []
  const params = []
  for (const [k, rawV] of Object.entries(req.body || {})) {
    // "duration" (H:MM / "90") → duration_minutes
    if (k === 'duration') {
      const mins = parseDurationToMinutes(rawV)
      if (mins == null) return res.status(400).json({ error: 'duration invalide' })
      updates.push('duration_minutes = ?')
      params.push(mins)
      continue
    }
    if (!ENTRY_PATCHABLE.has(k)) continue
    let v = rawV
    if (v === '' || v === undefined) v = null
    if (k === 'duration_minutes' && v !== null) {
      const n = parseDurationToMinutes(v)
      if (n == null) return res.status(400).json({ error: 'duration_minutes invalide' })
      v = n
    }
    if (k === 'rsde') v = v ? 1 : 0
    if (k === 'sort_order' && v !== null) v = parseInt(v, 10)
    updates.push(`${k} = ?`)
    params.push(v)
  }
  if (!updates.length) return res.status(400).json({ error: 'Aucun champ modifiable fourni' })
  updates.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
  params.push(req.params.id)
  db.prepare(`UPDATE timesheet_entries SET ${updates.join(', ')} WHERE id = ?`).run(...params)
  res.json(loadDayWithEntries(entry.day_id))
})

// DELETE /api/timesheets/entries/:id — hard delete (les entrées sont des sous-lignes)
router.delete('/entries/:id', (req, res) => {
  const entry = db.prepare(`
    SELECT e.day_id, d.user_id
    FROM timesheet_entries e
    JOIN timesheet_days d ON e.day_id = d.id
    WHERE e.id = ? AND d.deleted_at IS NULL
  `).get(req.params.id)
  if (!entry) return res.status(404).json({ error: 'Not found' })
  if (!resolveTargetUserId(req, entry.user_id)) return res.status(403).json({ error: 'Accès refusé' })
  db.prepare('DELETE FROM timesheet_entries WHERE id = ?').run(req.params.id)
  res.json(loadDayWithEntries(entry.day_id))
})

export default router
