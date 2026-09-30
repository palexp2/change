import { Router } from 'express'
import { newRecordId } from '../utils/recordId.js'
import db from '../db/database.js'
import { requireAuth, isHR } from '../middleware/auth.js'
import { parseDurationToMinutes } from '../services/duration.js'
import { emitEntity } from '../services/realtimeEmitters.js'

const router = Router()
router.use(requireAuth)

// Modes de saisie d'une JOURNÉE. 'week' n'en fait pas partie : une semaine
// déclarée d'un seul chiffre ne se rattache à aucune journée (voir timesheet_weeks).
const ALLOWED_MODES = new Set(['simple', 'detailed'])
// Modes de saisie proposés à l'employé — 'week' est une façon de travailler,
// donc une préférence, pas une propriété d'une journée.
const PREF_MODES = new Set(['simple', 'detailed', 'week'])

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MAX_WEEK_MINUTES = 7 * 24 * 60

// Dimanche de la semaine contenant `dateStr`. Calcul en UTC : la chaîne
// n'a pas de fuseau, on ne veut pas que le serveur en invente un.
function weekStartOf(dateStr) {
  if (!DATE_RE.test(String(dateStr || ''))) return null
  const d = new Date(dateStr + 'T00:00:00Z')
  if (Number.isNaN(d.getTime())) return null
  d.setUTCDate(d.getUTCDate() - d.getUTCDay())
  return d.toISOString().slice(0, 10)
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

// Admin et RH peuvent voir/modifier toutes les feuilles. Sinon, restreint à l'utilisateur connecté.
function resolveTargetUserId(req, requested) {
  const me = req.user
  if (!requested || requested === me.id) return me.id
  if (isHR(me)) return requested
  return null // not allowed
}

// Retourne un message d'erreur si `user` ne peut pas éditer le contenu de `day`
// (header ou entrées) à cause du verrouillage du workflow d'approbation, sinon null.
// - 'approved' : verrouillée pour tous, il faut d'abord la rouvrir (RH).
// - 'submitted' : verrouillée pour l'employé ; un gestionnaire RH peut encore corriger.
function editLockError(day, user) {
  if (day.status === 'approved') {
    return 'Feuille approuvée et verrouillée. Demandez à un gestionnaire de la rouvrir avant de la modifier.'
  }
  if (day.status === 'submitted' && !isHR(user)) {
    return 'Feuille soumise et verrouillée. Annulez la soumission pour la modifier.'
  }
  return null
}

function loadDayWithEntries(id) {
  const day = db.prepare(`
    SELECT d.*,
      su.name AS submitted_by_name,
      au.name AS approved_by_name,
      ru.name AS rejected_by_name
    FROM timesheet_days d
    LEFT JOIN users su ON d.submitted_by = su.id
    LEFT JOIN users au ON d.approved_by = au.id
    LEFT JOIN users ru ON d.rejected_by = ru.id
    WHERE d.id = ? AND d.deleted_at IS NULL
  `).get(id)
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

  // Charge toutes les entrées de la plage en une seule requête (WHERE day_id IN (...))
  // puis regroupe en mémoire, plutôt qu'une requête par jour (N+1).
  const entriesByDay = new Map()
  if (days.length) {
    const placeholders = days.map(() => '?').join(', ')
    const allEntries = db.prepare(`
      SELECT e.*, ac.name as activity_code_name, ac.payable as activity_code_payable, c.name as company_name
      FROM timesheet_entries e
      LEFT JOIN activity_codes ac ON e.activity_code_id = ac.id
      LEFT JOIN companies c ON e.company_id = c.id
      WHERE day_id IN (${placeholders})
      ORDER BY sort_order ASC, created_at ASC
    `).all(...days.map(d => d.id))
    for (const e of allEntries) {
      let arr = entriesByDay.get(e.day_id)
      if (!arr) { arr = []; entriesByDay.set(e.day_id, arr) }
      arr.push(e)
    }
  }

  const result = days.map(d => ({ ...d, entries: entriesByDay.get(d.id) || [] }))
  res.json({ data: result })
})

// GET /api/timesheets/users — RH : employés dont on peut ouvrir la feuille
// (la liste admin des comptes n'est pas accessible à un RH sans droit admin).
router.get('/users', (req, res) => {
  if (!isHR(req.user)) return res.status(403).json({ error: 'Accès refusé' })
  res.json(db.prepare(`SELECT id, name FROM users WHERE deleted_at IS NULL AND active = 1 ORDER BY name COLLATE NOCASE`).all())
})

// Périodes de paie : 14 jours du dimanche au samedi, ancrées au 30 août 2026
// (13 → 26 septembre 2026, etc.). Même ancre que la page Feuille de temps.
const PAY_PERIOD_ANCHOR = '2026-08-30'
function payPeriodStartOf(dateStr) {
  const days = Math.round((Date.parse(dateStr + 'T00:00:00Z') - Date.parse(PAY_PERIOD_ANCHOR + 'T00:00:00Z')) / 86400000)
  return addDays(PAY_PERIOD_ANCHOR, Math.floor(days / 14) * 14)
}
function hhmmToMin(t) {
  const [h, m] = String(t).split(':').map(n => parseInt(n, 10) || 0)
  return h * 60 + m
}

// GET /api/timesheets/period-totals?periods=6 — RH : heures payables de chaque
// employé par période de paie (jours + semaines déclarées d'un seul chiffre).
router.get('/period-totals', (req, res) => {
  if (!isHR(req.user)) return res.status(403).json({ error: 'Accès refusé' })
  const count = Math.min(26, Math.max(1, parseInt(req.query.periods, 10) || 6))
  const today = new Date().toISOString().slice(0, 10)
  const current = payPeriodStartOf(today)
  const periods = Array.from({ length: count }, (_, i) => addDays(current, -14 * i))
  const from = periods[periods.length - 1]
  const to = addDays(current, 13)

  const totals = new Map() // user_id → { period_start → minutes }
  const add = (userId, date, minutes) => {
    if (!minutes) return
    if (!totals.has(userId)) totals.set(userId, {})
    const p = payPeriodStartOf(date)
    const row = totals.get(userId)
    row[p] = (row[p] || 0) + minutes
  }

  const days = db.prepare(`
    SELECT d.id, d.user_id, d.date, d.mode, d.start_time, d.end_time, d.break_minutes,
      (SELECT COALESCE(SUM(e.duration_minutes), 0) FROM timesheet_entries e
         LEFT JOIN activity_codes ac ON e.activity_code_id = ac.id
        WHERE e.day_id = d.id AND (ac.payable IS NULL OR ac.payable = 1)) AS entries_minutes
    FROM timesheet_days d
    WHERE d.deleted_at IS NULL AND d.date >= ? AND d.date <= ?
  `).all(from, to)
  for (const d of days) {
    let min = 0
    if (d.mode === 'detailed') min = Number(d.entries_minutes) || 0
    else if (d.start_time && d.end_time) min = Math.max(0, hhmmToMin(d.end_time) - hhmmToMin(d.start_time) - (Number(d.break_minutes) || 0))
    add(d.user_id, d.date, min)
  }
  const weeks = db.prepare(`
    SELECT user_id, week_start, minutes FROM timesheet_weeks
    WHERE deleted_at IS NULL AND week_start >= ? AND week_start <= ?
  `).all(from, to)
  for (const w of weeks) add(w.user_id, w.week_start, Number(w.minutes) || 0)

  const ids = [...totals.keys()]
  const names = new Map(ids.length
    ? db.prepare(`SELECT id, name FROM users WHERE id IN (${ids.map(() => '?').join(', ')})`).all(...ids).map(u => [u.id, u.name])
    : [])
  const users = ids
    .map(id => ({ user_id: id, name: names.get(id) || '—', totals: totals.get(id) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'))
  res.json({ periods, users })
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

// GET /api/timesheets/preferences[?user_id=X] — mode de saisie de l'employé.
// `user_id` (RH/admin seulement) : le mode est propre à l'employé consulté, pas
// à celui qui regarde — sinon un gestionnaire en mode « détaillé » verrait la
// feuille d'un employé en mode « semaine » avec le mauvais formulaire.
router.get('/preferences', (req, res) => {
  const target = resolveTargetUserId(req, req.query.user_id)
  if (!target) return res.status(403).json({ error: 'Accès refusé' })
  const row = db.prepare('SELECT timesheet_default_mode FROM users WHERE id = ?').get(target)
  const mode = row?.timesheet_default_mode
  res.json({ default_mode: PREF_MODES.has(mode) ? mode : 'simple', user_id: target })
})

// PATCH /api/timesheets/preferences — maj explicite du mode de saisie
router.patch('/preferences', (req, res) => {
  const target = resolveTargetUserId(req, req.body?.user_id)
  if (!target) return res.status(403).json({ error: 'Accès refusé' })
  const { default_mode } = req.body || {}
  if (!PREF_MODES.has(default_mode)) return res.status(400).json({ error: 'default_mode invalide' })
  db.prepare('UPDATE users SET timesheet_default_mode = ? WHERE id = ?').run(default_mode, target)
  res.json({ default_mode, user_id: target })
})

// ── Mode « semaine » : un seul chiffre pour la semaine complète ──────────────
// Une ligne par (employé, dimanche) dans timesheet_weeks. Aucune journée n'est
// créée : c'est ce qui rend le total non ambigu à la paie.

function loadWeek(userId, weekStart) {
  return db.prepare(`
    SELECT * FROM timesheet_weeks
    WHERE user_id = ? AND week_start = ? AND deleted_at IS NULL
  `).get(userId, weekStart) || null
}

// Heures déjà saisies au JOUR dans la semaine — un total hebdo par-dessus
// serait compté deux fois par l'import de paie.
function weekHasDayHours(userId, weekStart) {
  const { n } = db.prepare(`
    SELECT COUNT(*) AS n FROM timesheet_days d
    WHERE d.user_id = ? AND d.deleted_at IS NULL
      AND d.date >= ? AND d.date <= ?
      AND (
        (d.mode = 'simple' AND d.start_time IS NOT NULL AND d.end_time IS NOT NULL)
        OR EXISTS (SELECT 1 FROM timesheet_entries e WHERE e.day_id = d.id)
      )
  `).get(userId, weekStart, addDays(weekStart, 6))
  return n > 0
}

// Total hebdomadaire déclaré pour la semaine contenant `date` (0 si aucun) —
// symétrique de weekHasDayHours : on refuse aussi d'ajouter des heures au jour
// dans une semaine déjà déclarée d'un seul chiffre.
function weekTotalFor(userId, date) {
  const weekStart = weekStartOf(date)
  if (!weekStart) return 0
  return Number(loadWeek(userId, weekStart)?.minutes) || 0
}
const WEEK_DECLARED_ERROR =
  'Cette semaine est déclarée d\'un seul total hebdomadaire. Remettez-le à 0 avant de saisir des heures au jour.'

// GET /api/timesheets/week?user_id=X&date=YYYY-MM-DD — `date` = n'importe quel jour de la semaine
router.get('/week', (req, res) => {
  const target = resolveTargetUserId(req, req.query.user_id)
  if (!target) return res.status(403).json({ error: 'Accès refusé' })
  const weekStart = weekStartOf(req.query.date)
  if (!weekStart) return res.status(400).json({ error: 'date requise (YYYY-MM-DD)' })
  res.json(loadWeek(target, weekStart))
})

// GET /api/timesheets/weeks?user_id=X&from=&to= — bornes sur le dimanche de la semaine
router.get('/weeks', (req, res) => {
  const target = resolveTargetUserId(req, req.query.user_id)
  if (!target) return res.status(403).json({ error: 'Accès refusé' })
  let where = 'WHERE deleted_at IS NULL AND user_id = ?'
  const params = [target]
  if (req.query.from) { where += ' AND week_start >= ?'; params.push(req.query.from) }
  if (req.query.to) { where += ' AND week_start <= ?'; params.push(req.query.to) }
  const data = db.prepare(`SELECT * FROM timesheet_weeks ${where} ORDER BY week_start DESC`).all(...params)
  res.json({ data })
})

// PUT /api/timesheets/week — upsert du total de la semaine (autosave d'un champ unique)
router.put('/week', (req, res) => {
  const target = resolveTargetUserId(req, req.body?.user_id)
  if (!target) return res.status(403).json({ error: 'Accès refusé' })
  const weekStart = weekStartOf(req.body?.date)
  if (!weekStart) return res.status(400).json({ error: 'date requise (YYYY-MM-DD)' })

  const raw = req.body?.minutes != null ? req.body.minutes : req.body?.duration
  const minutes = parseDurationToMinutes(raw)
  if (minutes == null) return res.status(400).json({ error: 'minutes invalide' })
  if (minutes > MAX_WEEK_MINUTES) return res.status(400).json({ error: 'Total hebdomadaire irréaliste' })

  if (minutes > 0 && weekHasDayHours(target, weekStart)) {
    return res.status(409).json({
      error: 'Cette semaine contient déjà des heures saisies au jour. Supprimez-les avant de déclarer un total hebdomadaire.',
    })
  }

  const existing = loadWeek(target, weekStart)
  if (existing) {
    db.prepare(`UPDATE timesheet_weeks SET minutes = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
      .run(minutes, existing.id)
    return res.json(loadWeek(target, weekStart))
  }
  db.prepare('INSERT INTO timesheet_weeks (id, user_id, week_start, minutes) VALUES (?, ?, ?, ?)')
    .run(newRecordId(), target, weekStart, minutes)
  res.status(201).json(loadWeek(target, weekStart))
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

  const id = newRecordId()
  db.prepare(`
    INSERT INTO timesheet_days (id, user_id, date, mode)
    VALUES (?, ?, ?, ?)
  `).run(id, target, date, mode)
  // Synchronise la pref uniquement si le user agit sur sa propre journée.
  // `mode` fourni explicitement seulement : sinon la création d'une journée
  // ferait sortir du mode « semaine » un employé qui y est, sans qu'il l'ait
  // demandé (le mode semaine n'existe pas au niveau de la journée).
  if (req.user.id === target && typeof req.body?.mode === 'string') {
    db.prepare('UPDATE users SET timesheet_default_mode = ? WHERE id = ?').run(mode, req.user.id)
  }
  const created = loadDayWithEntries(id)
  emitEntity('timesheet', 'created', id, created, req.user?.id)
  res.status(201).json(created)
})

const DAY_PATCHABLE = new Set(['mode', 'start_time', 'end_time', 'break_minutes'])

// PATCH /api/timesheets/day/:id
router.patch('/day/:id', (req, res) => {
  const day = db.prepare('SELECT * FROM timesheet_days WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!day) return res.status(404).json({ error: 'Not found' })
  const target = resolveTargetUserId(req, day.user_id)
  if (!target) return res.status(403).json({ error: 'Accès refusé' })
  const lockMsg = editLockError(day, req.user)
  if (lockMsg) return res.status(409).json({ error: lockMsg })

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
    if ((k === 'start_time' || k === 'end_time') && v !== null && weekTotalFor(day.user_id, day.date) > 0) {
      return res.status(409).json({ error: WEEK_DECLARED_ERROR })
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
  const updated = loadDayWithEntries(req.params.id)
  emitEntity('timesheet', 'updated', req.params.id, updated, req.user?.id)
  res.json(updated)
})

// DELETE /api/timesheets/day/:id — soft delete (aligné avec le reste de l'app)
router.delete('/day/:id', (req, res) => {
  const day = db.prepare('SELECT user_id, status FROM timesheet_days WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!day) return res.status(404).json({ error: 'Not found' })
  if (!resolveTargetUserId(req, day.user_id)) return res.status(403).json({ error: 'Accès refusé' })
  const lockMsg = editLockError(day, req.user)
  if (lockMsg) return res.status(409).json({ error: lockMsg })
  db.prepare(`UPDATE timesheet_days SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(req.params.id)
  emitEntity('timesheet', 'deleted', req.params.id, { id: req.params.id }, req.user?.id)
  res.json({ success: true })
})

// PATCH /api/timesheets/day/:id/status — workflow d'approbation / verrouillage.
// Transitions autorisées :
//   draft|rejected → submitted   (employé ou RH) : soumet pour approbation, verrouille côté employé
//   submitted      → approved    (RH seulement)  : signe et verrouille pour tous
//   submitted      → rejected    (RH seulement)  : renvoie à l'employé avec un motif obligatoire
//   submitted      → draft       (employé ou RH) : retire la soumission (avant approbation)
//   approved       → draft       (RH seulement)  : rouvre une feuille approuvée
const STATUS_VALUES = new Set(['draft', 'submitted', 'approved', 'rejected'])
const ALLOWED_TRANSITIONS = {
  draft: ['submitted'],
  rejected: ['submitted'],
  submitted: ['approved', 'rejected', 'draft'],
  approved: ['draft'],
}

router.patch('/day/:id/status', (req, res) => {
  const day = db.prepare('SELECT * FROM timesheet_days WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!day) return res.status(404).json({ error: 'Not found' })
  if (!resolveTargetUserId(req, day.user_id)) return res.status(403).json({ error: 'Accès refusé' })

  const { status } = req.body || {}
  const reason = (req.body?.reason || '').trim()
  if (!STATUS_VALUES.has(status)) return res.status(400).json({ error: 'status invalide' })

  const from = day.status || 'draft'
  if (status === from) return res.json(loadDayWithEntries(day.id))
  if (!ALLOWED_TRANSITIONS[from]?.includes(status)) {
    return res.status(409).json({ error: `Transition ${from} → ${status} non autorisée` })
  }

  const hr = isHR(req.user)
  // Séparation des tâches : seul un gestionnaire RH approuve, rejette, ou rouvre une feuille approuvée.
  if (status === 'approved' || status === 'rejected') {
    if (!hr) return res.status(403).json({ error: 'Seul un gestionnaire RH peut approuver ou rejeter une feuille' })
  }
  if (status === 'draft' && from === 'approved' && !hr) {
    return res.status(403).json({ error: 'Seul un gestionnaire RH peut rouvrir une feuille approuvée' })
  }
  if (status === 'rejected' && !reason) {
    return res.status(400).json({ error: 'Un motif de rejet est requis' })
  }

  const now = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
  let sql
  const params = []
  if (status === 'submitted') {
    // Nouvelle soumission : on efface tout rejet antérieur.
    sql = `UPDATE timesheet_days SET status = 'submitted', submitted_at = ${now}, submitted_by = ?,
             rejected_at = NULL, rejected_by = NULL, rejection_reason = NULL, updated_at = ${now} WHERE id = ?`
    params.push(req.user.id, req.params.id)
  } else if (status === 'approved') {
    sql = `UPDATE timesheet_days SET status = 'approved', approved_at = ${now}, approved_by = ?, updated_at = ${now} WHERE id = ?`
    params.push(req.user.id, req.params.id)
  } else if (status === 'rejected') {
    sql = `UPDATE timesheet_days SET status = 'rejected', rejected_at = ${now}, rejected_by = ?,
             rejection_reason = ?, approved_at = NULL, approved_by = NULL, updated_at = ${now} WHERE id = ?`
    params.push(req.user.id, reason, req.params.id)
  } else {
    // Retour à draft (retrait de soumission ou réouverture) : on efface la piste de soumission/approbation.
    sql = `UPDATE timesheet_days SET status = 'draft', submitted_at = NULL, submitted_by = NULL,
             approved_at = NULL, approved_by = NULL, rejected_at = NULL, rejected_by = NULL,
             rejection_reason = NULL, updated_at = ${now} WHERE id = ?`
    params.push(req.params.id)
  }
  db.prepare(sql).run(...params)
  const updated = loadDayWithEntries(req.params.id)
  emitEntity('timesheet', 'updated', req.params.id, updated, req.user?.id)
  res.json(updated)
})

// POST /api/timesheets/day/:dayId/entries — ajoute une activité
router.post('/day/:dayId/entries', (req, res) => {
  const day = db.prepare('SELECT user_id, date, status FROM timesheet_days WHERE id = ? AND deleted_at IS NULL').get(req.params.dayId)
  if (!day) return res.status(404).json({ error: 'Day not found' })
  if (!resolveTargetUserId(req, day.user_id)) return res.status(403).json({ error: 'Accès refusé' })
  const lockMsg = editLockError(day, req.user)
  if (lockMsg) return res.status(409).json({ error: lockMsg })
  if (weekTotalFor(day.user_id, day.date) > 0) return res.status(409).json({ error: WEEK_DECLARED_ERROR })

  const { description, activity_code_id, company_id, duration, duration_minutes, rsde, sort_order } = req.body || {}
  const mins = duration_minutes != null
    ? parseInt(duration_minutes, 10) || 0
    : (parseDurationToMinutes(duration) || 0)

  // sort_order par défaut = max + 1 dans la journée
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 as next FROM timesheet_entries WHERE day_id = ?').get(req.params.dayId).next
  const id = newRecordId()
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
  const updated = loadDayWithEntries(req.params.dayId)
  emitEntity('timesheet', 'updated', req.params.dayId, updated, req.user?.id)
  res.status(201).json(updated)
})

const ENTRY_PATCHABLE = new Set(['description', 'activity_code_id', 'company_id', 'duration_minutes', 'rsde', 'sort_order'])

// PATCH /api/timesheets/entries/:id — met à jour une activité
router.patch('/entries/:id', (req, res) => {
  const entry = db.prepare(`
    SELECT e.*, d.user_id, d.status
    FROM timesheet_entries e
    JOIN timesheet_days d ON e.day_id = d.id
    WHERE e.id = ? AND d.deleted_at IS NULL
  `).get(req.params.id)
  if (!entry) return res.status(404).json({ error: 'Not found' })
  if (!resolveTargetUserId(req, entry.user_id)) return res.status(403).json({ error: 'Accès refusé' })
  const lockMsg = editLockError(entry, req.user)
  if (lockMsg) return res.status(409).json({ error: lockMsg })

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
  const updated = loadDayWithEntries(entry.day_id)
  emitEntity('timesheet', 'updated', entry.day_id, updated, req.user?.id)
  res.json(updated)
})

// DELETE /api/timesheets/entries/:id — hard delete (les entrées sont des sous-lignes)
router.delete('/entries/:id', (req, res) => {
  const entry = db.prepare(`
    SELECT e.day_id, d.user_id, d.status
    FROM timesheet_entries e
    JOIN timesheet_days d ON e.day_id = d.id
    WHERE e.id = ? AND d.deleted_at IS NULL
  `).get(req.params.id)
  if (!entry) return res.status(404).json({ error: 'Not found' })
  if (!resolveTargetUserId(req, entry.user_id)) return res.status(403).json({ error: 'Accès refusé' })
  const lockMsg = editLockError(entry, req.user)
  if (lockMsg) return res.status(409).json({ error: lockMsg })
  db.prepare('DELETE FROM timesheet_entries WHERE id = ?').run(req.params.id)
  const updated = loadDayWithEntries(entry.day_id)
  emitEntity('timesheet', 'updated', entry.day_id, updated, req.user?.id)
  res.json(updated)
})

export default router
