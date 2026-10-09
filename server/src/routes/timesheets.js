import { Router } from 'express'
import { newRecordId } from '../utils/recordId.js'
import db from '../db/database.js'
import { requireAuth, isHR } from '../middleware/auth.js'
import { parseDurationToMinutes } from '../services/duration.js'
import { emitEntity } from '../services/realtimeEmitters.js'
import { dayPayableMinutes } from '../services/timesheetHours.js'
import { userForEmployee } from '../services/paieTimesheetImport.js'
import { scheduleTimesheetPaieSync } from '../services/timesheetPaieSync.js'
import { isRdSheetMember, rdMonthGrid, applySheetValueToBoreal, canonicalProject, rdSuggestions, codeForProject } from '../services/rdTimesheetSheetSync.js'

const router = Router()
router.use(requireAuth)
// Toute saisie réussie relance (avec un délai) la recopie des heures dans les
// paies ouvertes (Airtable).
router.use((req, res, next) => {
  if (req.method !== 'GET') res.on('finish', () => { if (res.statusCode < 300) scheduleTimesheetPaieSync() })
  next()
})

// Modes de saisie d'une JOURNÉE. Le mode « semaine » est retiré (2026-10-08) :
// les semaines déclarées ont été réparties en journées (migration 120).
const ALLOWED_MODES = new Set(['simple'])
const PREF_MODES = new Set(['simple', 'month'])

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

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

// Une ligne est R&D quand son code porte un projet RS&DE : c'est le code qui
// décide, plus une case à cocher (sauf code sans projet : on garde ce qui est là).
function rsdeForCode(codeId) {
  if (!codeId) return 0
  const code = db.prepare('SELECT rsde_project, rsde_default FROM activity_codes WHERE id = ?').get(codeId)
  return code && (code.rsde_project || code.rsde_default) ? 1 : 0
}

// Activités hors R&D proposées à côté des projets sur une ligne : chacune est
// un code (semé dans schema.js), payable ou non.
const OTHER_ACTIVITIES = ['Autres', 'Non payée']
function otherActivityCode(name) {
  return OTHER_ACTIVITIES.includes(name)
    ? db.prepare('SELECT id FROM activity_codes WHERE name = ? AND deleted_at IS NULL').get(name)?.id || null
    : null
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
    SELECT e.*, ac.name as activity_code_name, ac.payable as activity_code_payable, COALESCE(e.rsde_project, ac.rsde_project) as activity_code_project, c.name as company_name
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
      SELECT e.*, ac.name as activity_code_name, ac.payable as activity_code_payable, COALESCE(e.rsde_project, ac.rsde_project) as activity_code_project, c.name as company_name
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

// Comptes de service (agent, tests e2e) : pas des employés.
const NON_EMPLOYEE_EMAILS = ['claude@orisha.io']
const NON_EMPLOYEE_SQL = `lower(COALESCE(email, '')) NOT IN (${NON_EMPLOYEE_EMAILS.map(() => '?').join(', ')})`

// GET /api/timesheets/users — RH : employés dont on peut ouvrir la feuille
// (la liste admin des comptes n'est pas accessible à un RH sans droit admin).
router.get('/users', (req, res) => {
  if (!isHR(req.user)) return res.status(403).json({ error: 'Accès refusé' })
  res.json(db.prepare(`SELECT id, name FROM users WHERE deleted_at IS NULL AND active = 1 AND ${NON_EMPLOYEE_SQL} ORDER BY name COLLATE NOCASE`).all(...NON_EMPLOYEE_EMAILS))
})

// Périodes de paie : 14 jours du dimanche au samedi, ancrées au 30 août 2026
// (13 → 26 septembre 2026, etc.). Même ancre que la page Feuille de temps.
const PAY_PERIOD_ANCHOR = '2026-08-30'
function payPeriodStartOf(dateStr) {
  const days = Math.round((Date.parse(dateStr + 'T00:00:00Z') - Date.parse(PAY_PERIOD_ANCHOR + 'T00:00:00Z')) / 86400000)
  return addDays(PAY_PERIOD_ANCHOR, Math.floor(days / 14) * 14)
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
    add(d.user_id, d.date, dayPayableMinutes(d, d.entries_minutes))
  }
  const weeks = db.prepare(`
    SELECT user_id, week_start, minutes FROM timesheet_weeks
    WHERE deleted_at IS NULL AND week_start >= ? AND week_start <= ?
  `).all(from, to)
  for (const w of weeks) add(w.user_id, w.week_start, Number(w.minutes) || 0)

  // Qui ne saisit rien dans Boréal sur une période : les heures de sa ligne de
  // paie (Airtable) comblent la case, marquées comme venant d'Airtable.
  const sources = new Map() // clé → { period_start → 'airtable' }
  const empNames = new Map()
  const items = db.prepare(`
    SELECT p.period_start, p.period_end, pi.regular_hours, e.id AS emp_id, e.first_name, e.last_name
    FROM paie_items pi JOIN paies p ON p.id = pi.paie_id JOIN employees e ON e.id = pi.employee_id
    WHERE p.period_end >= ? AND p.period_end <= ? AND pi.regular_hours > 0
  `).all(from, addDays(to, 13))
  for (const it of items) {
    const period = payPeriodStartOf(it.period_start || addDays(it.period_end, -13))
    if (!periods.includes(period)) continue
    const user = userForEmployee({ id: it.emp_id, first_name: it.first_name, last_name: it.last_name })
    const key = user?.id || `emp:${it.emp_id}`
    if (!user) empNames.set(key, [it.first_name, it.last_name].filter(Boolean).join(' '))
    if (totals.get(key)?.[period]) continue
    add(key, period, Math.round(Number(it.regular_hours) * 60))
    if (!sources.has(key)) sources.set(key, {})
    sources.get(key)[period] = 'airtable'
  }

  const hidden = new Set(db.prepare(`SELECT id FROM users WHERE NOT (${NON_EMPLOYEE_SQL})`).all(...NON_EMPLOYEE_EMAILS).map(u => u.id))
  const ids = [...totals.keys()].filter(id => !hidden.has(id))
  const userIds = ids.filter(id => !id.startsWith('emp:'))
  const names = new Map(userIds.length
    ? db.prepare(`SELECT id, name FROM users WHERE id IN (${userIds.map(() => '?').join(', ')})`).all(...userIds).map(u => [u.id, u.name])
    : [])
  const users = ids
    .map(id => ({ user_id: id, name: names.get(id) || empNames.get(id) || '—', totals: totals.get(id), sources: sources.get(id) || {} }))
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
  res.json({ default_mode: PREF_MODES.has(mode) ? mode : 'simple', paid_weekly: isPaidWeekly(target), user_id: target, rd_sheet: isRdSheetMember(target) })
})

// Payé à la semaine = « Heures par semaine » rempli sur la fiche employé.
function isPaidWeekly(userId) {
  const linked = db.prepare('SELECT e.hours_per_week FROM users u JOIN employees e ON e.id = u.employee_id WHERE u.id = ?').get(userId)
  if (linked) return Number(linked.hours_per_week) > 0
  return db.prepare('SELECT id, first_name, last_name FROM employees WHERE hours_per_week > 0').all()
    .some(e => userForEmployee(e)?.id === userId)
}

// ── Vue « Mois » : la grille de l'onglet de la feuille du Drive ──────────────

// GET /api/timesheets/rd-month?user_id=X&month=YYYY-MM
router.get('/rd-month', async (req, res) => {
  const target = resolveTargetUserId(req, req.query.user_id)
  if (!target) return res.status(403).json({ error: 'Accès refusé' })
  const month = String(req.query.month || '')
  if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month requis (YYYY-MM)' })
  res.json({ month, rows: rdMonthGrid(target, month), suggestions: await rdSuggestions(target, month) })
})

// PUT /api/timesheets/rd-day { user_id, date, hours, desc, project } — la
// partie R&D d'une ligne de la grille : remplace les lignes R&D de la journée
// par une seule, exactement comme une saisie dans la feuille du Drive.
router.put('/rd-day', (req, res) => {
  const target = resolveTargetUserId(req, req.body?.user_id)
  if (!target) return res.status(403).json({ error: 'Accès refusé' })
  const { date } = req.body || {}
  if (!DATE_RE.test(String(date || ''))) return res.status(400).json({ error: 'date requise (YYYY-MM-DD)' })
  const hours = Number(String(req.body?.hours ?? 0).replace(',', '.'))
  if (!Number.isFinite(hours) || hours < 0 || hours > 24) return res.status(400).json({ error: 'Heures invalides' })
  const day = db.prepare('SELECT * FROM timesheet_days WHERE user_id = ? AND date = ? AND deleted_at IS NULL').get(target, date)
  if (day) {
    const lockMsg = editLockError(day, req.user)
    if (lockMsg) return res.status(409).json({ error: lockMsg })
  }
  const refusal = applySheetValueToBoreal(target, date, {
    hours, desc: String(req.body?.desc || '').trim(), project: canonicalProject(req.body?.project) || 'Fiabilité',
  })
  if (refusal) return res.status(409).json({ error: refusal })
  const row = rdMonthGrid(target, date.slice(0, 7)).find(r => r.date === date)
  res.json(row)
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

// POST /api/timesheets/day/copy-previous { date, user_id } — « Copier hier » :
// reprend la dernière journée remplie des 14 jours précédents (arrivée, départ,
// pause et lignes) sur une journée encore vide.
router.post('/day/copy-previous', (req, res) => {
  const target = resolveTargetUserId(req, req.body?.user_id)
  if (!target) return res.status(403).json({ error: 'Accès refusé' })
  const date = req.body?.date
  if (!DATE_RE.test(String(date || ''))) return res.status(400).json({ error: 'date requise (YYYY-MM-DD)' })

  const existing = db.prepare('SELECT * FROM timesheet_days WHERE user_id = ? AND date = ? AND deleted_at IS NULL').get(target, date)
  if (existing) {
    const lockMsg = editLockError(existing, req.user)
    if (lockMsg) return res.status(409).json({ error: lockMsg })
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM timesheet_entries WHERE day_id = ?').get(existing.id)
    if (n > 0 || existing.start_time || existing.end_time) return res.status(409).json({ error: 'La journée contient déjà des heures.' })
  }
  const source = db.prepare(`
    SELECT d.* FROM timesheet_days d
    WHERE d.user_id = ? AND d.deleted_at IS NULL AND d.date < ? AND d.date >= ?
      AND ((d.start_time IS NOT NULL AND d.end_time IS NOT NULL)
        OR EXISTS (SELECT 1 FROM timesheet_entries e WHERE e.day_id = d.id))
    ORDER BY d.date DESC LIMIT 1
  `).get(target, date, addDays(date, -14))
  if (!source) return res.status(404).json({ error: 'Aucune journée récente à copier.' })

  const dayId = existing?.id || newRecordId()
  db.transaction(() => {
    if (existing) {
      db.prepare(`UPDATE timesheet_days SET start_time = ?, end_time = ?, break_minutes = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
        .run(source.start_time, source.end_time, source.break_minutes, dayId)
    } else {
      db.prepare('INSERT INTO timesheet_days (id, user_id, date, mode, start_time, end_time, break_minutes) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(dayId, target, date, 'simple', source.start_time, source.end_time, source.break_minutes)
    }
    const ins = db.prepare(`
      INSERT INTO timesheet_entries (id, day_id, sort_order, description, activity_code_id, company_id, duration_minutes, rsde, rsde_project)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const e of db.prepare('SELECT * FROM timesheet_entries WHERE day_id = ? ORDER BY sort_order, created_at').all(source.id)) {
      ins.run(newRecordId(), dayId, e.sort_order, e.description, e.activity_code_id, e.company_id, e.duration_minutes, e.rsde, e.rsde_project)
    }
  })()
  const day = loadDayWithEntries(dayId)
  emitEntity('timesheet', existing ? 'updated' : 'created', dayId, day, req.user?.id)
  res.status(existing ? 200 : 201).json(day)
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

const DAY_PATCHABLE = new Set(['mode', 'start_time', 'end_time', 'break_minutes', 'notes'])

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
    activity_code_id ? rsdeForCode(activity_code_id) : (rsde ? 1 : 0),
  )
  const updated = loadDayWithEntries(req.params.dayId)
  emitEntity('timesheet', 'updated', req.params.dayId, updated, req.user?.id)
  res.status(201).json(updated)
})

// PUT /api/timesheets/day/:dayId/rd — temps R&D d'une journée simplifiée :
// { minutes, project, description? } remplace ses lignes R&D par une seule
// (0 = aucune). Sans description fournie, celle de l'ancienne ligne est gardée.
// Le code est celui que la personne emploie déjà pour ce projet.
router.put('/day/:dayId/rd', (req, res) => {
  const day = db.prepare('SELECT user_id, date, status FROM timesheet_days WHERE id = ? AND deleted_at IS NULL').get(req.params.dayId)
  if (!day) return res.status(404).json({ error: 'Day not found' })
  if (!resolveTargetUserId(req, day.user_id)) return res.status(403).json({ error: 'Accès refusé' })
  const lockMsg = editLockError(day, req.user)
  if (lockMsg) return res.status(409).json({ error: lockMsg })

  const mins = parseDurationToMinutes(req.body?.minutes ?? 0)
  if (mins == null || mins < 0 || mins > 24 * 60) return res.status(400).json({ error: 'minutes invalide' })
  const project = canonicalProject(req.body?.project) || null
  const codeId = mins > 0 ? codeForProject(day.user_id, project) : null
  const description = typeof req.body?.description === 'string' ? (req.body.description.trim() || null) : undefined

  db.transaction(() => {
    const prev = db.prepare('SELECT description FROM timesheet_entries WHERE day_id = ? AND rsde = 1 ORDER BY sort_order LIMIT 1').get(req.params.dayId)
    db.prepare('DELETE FROM timesheet_entries WHERE day_id = ? AND rsde = 1').run(req.params.dayId)
    if (mins > 0) {
      const next = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM timesheet_entries WHERE day_id = ?').get(req.params.dayId).n
      // Projet posé sur la ligne : il tient même sans code actif pour ce projet.
      db.prepare(`INSERT INTO timesheet_entries (id, day_id, sort_order, description, activity_code_id, duration_minutes, rsde, rsde_project)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?)`).run(newRecordId(), req.params.dayId, next, description !== undefined ? description : (prev?.description || null), codeId, mins, project)
    }
    db.prepare(`UPDATE timesheet_days SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(req.params.dayId)
  })()
  const updated = loadDayWithEntries(req.params.dayId)
  emitEntity('timesheet', 'updated', req.params.dayId, updated, req.user?.id)
  res.json(updated)
})

const ENTRY_PATCHABLE = new Set(['description', 'activity_code_id', 'company_id', 'duration_minutes', 'rsde', 'rsde_project', 'sort_order'])

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
  // Projet RSDE choisi sur la ligne (les codes d'activité ne se choisissent plus) :
  // pose le projet et son code R&D, ou les retire tous deux.
  if ('project' in (req.body || {})) {
    const other = otherActivityCode(req.body.project)
    const p = other ? null : canonicalProject(req.body.project) || null
    updates.push('rsde_project = ?', 'activity_code_id = ?', 'rsde = ?')
    params.push(p, other || (p ? codeForProject(entry.user_id, p) : null), p ? 1 : 0)
  }
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
    if (k === 'rsde_project') v = canonicalProject(v) || null
    updates.push(`${k} = ?`)
    params.push(v)
    // Choisir un projet rend la ligne R&D ; le retirer la ramène au projet du code.
    if (k === 'rsde_project' && !('rsde' in (req.body || {}))) {
      updates.push('rsde = ?')
      params.push(v ? 1 : rsdeForCode(req.body.activity_code_id ?? entry.activity_code_id))
    }
    if (k === 'activity_code_id' && !('rsde' in (req.body || {}))) {
      updates.push('rsde = ?')
      params.push(rsdeForCode(v) || (entry.rsde_project ? 1 : 0))
    }
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
