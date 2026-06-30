import { Router } from 'express'
import { randomUUID } from 'crypto'
import db from '../db/database.js'
import { requireAuth, isHROrAdmin } from '../middleware/auth.js'
import { importTimesheetsForPaie } from '../services/paieTimesheetImport.js'
import { emitEntity } from '../services/realtimeEmitters.js'

function myEmployeeId(userId) {
  const row = db.prepare('SELECT employee_id FROM users WHERE id = ?').get(userId)
  return row?.employee_id || null
}

function ensureHR(req, res, next) {
  if (!isHROrAdmin(req.user)) return res.status(403).json({ error: 'Accès RH requis' })
  next()
}

// Garde « impossible by design » sur le nombre de jours fériés d'une paie. Sans
// ce contrôle, un `nb_holiday_days` négatif AUGMENTAIT les heures régulières
// (regularHours -= nbHolidays × …, avec nbHolidays < 0) et le bonus 1/20, tandis
// qu'un NaN était silencieusement ramené à 0 par `Number(v) || 0`. On exige donc
// un entier ≥ 0. Une valeur absente / vide reste tolérée (= 0 jour férié).
function validateNbHolidayDays(body) {
  if (!Object.prototype.hasOwnProperty.call(body, 'nb_holiday_days')) return null
  const v = body.nb_holiday_days
  if (v === null || v === '' || v === undefined) return null
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0) {
    return `nb_holiday_days doit être un entier positif (reçu : ${JSON.stringify(v)})`
  }
  return null
}

function buildPaieListRow(id) {
  return db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM paie_items WHERE paie_id = p.id) AS items_count,
      (SELECT SUM(regular_hours) FROM paie_items WHERE paie_id = p.id) AS total_regular_hours,
      (SELECT SUM(COALESCE(regular_hours,0) * COALESCE(hourly_rate,0)) FROM paie_items WHERE paie_id = p.id) AS total_regular_amount
    FROM paies p
    WHERE p.id = ?
  `).get(id)
}

const router = Router()
router.use(requireAuth)

const ALLOWED = [
  'number', 'period_start', 'period_end', 'status', 'nb_holiday_days', 'total_with_charges_and_reimb',
  'timesheets_deadline', 'timesheets_sent', 'includes_hourly', 'includes_mileage',
  'includes_expense_reimb', 'includes_paid_leave', 'includes_holiday_hours',
  'includes_sales_commissions',
]

router.get('/sync-config', (req, res) => {
  const cfg = db.prepare("SELECT module, base_id, table_id, field_map, last_synced_at FROM airtable_module_config WHERE module='paies'").get() || {}
  res.json(cfg)
})

router.get('/', (req, res) => {
  const { q, page = 1, limit = 100 } = req.query
  const limitVal = parseInt(limit)
  const offset = (parseInt(page) - 1) * limitVal
  const hr = isHROrAdmin(req.user)
  const empId = hr ? null : myEmployeeId(req.user.id)
  if (!hr && !empId) return res.json({ data: [], total: 0, page: parseInt(page), limit: limitVal })

  const conditions = []
  const params = []
  if (q) {
    conditions.push('(p.status LIKE ? OR CAST(p.number AS TEXT) LIKE ?)')
    const like = `%${q}%`
    params.push(like, like)
  }
  if (!hr) {
    conditions.push('EXISTS (SELECT 1 FROM paie_items pi WHERE pi.paie_id = p.id AND pi.employee_id = ?)')
    params.push(empId)
  }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''

  const total = db.prepare(`SELECT COUNT(*) c FROM paies p ${where}`).get(...params).c

  // Pour les non-RH, les agrégats (total_regular_hours, items_count, etc.) sont
  // limités à leur propre paie_item afin de ne pas exposer les volumes globaux.
  const itemFilter = hr ? '' : 'AND employee_id = ?'
  const itemParams = hr ? [] : [empId]
  const rows = db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM paie_items WHERE paie_id = p.id ${itemFilter}) AS items_count,
      (SELECT SUM(regular_hours) FROM paie_items WHERE paie_id = p.id ${itemFilter}) AS total_regular_hours,
      (SELECT SUM(COALESCE(regular_hours,0) * COALESCE(hourly_rate,0)) FROM paie_items WHERE paie_id = p.id ${itemFilter}) AS total_regular_amount
    FROM paies p
    ${where}
    ORDER BY p.period_end DESC, p.number DESC
    LIMIT ? OFFSET ?
  `).all(...itemParams, ...itemParams, ...itemParams, ...params, limitVal, offset)

  res.json({ data: rows, total, page: parseInt(page), limit: limitVal })
})

router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM paies WHERE id=?').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  const hr = isHROrAdmin(req.user)
  const empId = hr ? null : myEmployeeId(req.user.id)
  const itemFilter = hr ? '' : 'AND pi.employee_id = ?'
  const itemParams = hr ? [req.params.id] : [req.params.id, empId]
  const items = db.prepare(`
    SELECT pi.*, e.first_name, e.last_name, e.matricule, e.accounting_department
    FROM paie_items pi
    LEFT JOIN employees e ON e.id = pi.employee_id
    WHERE pi.paie_id = ? ${itemFilter}
    ORDER BY e.last_name, e.first_name
  `).all(...itemParams)
  if (!hr && items.length === 0) return res.status(403).json({ error: 'Accès refusé' })
  res.json({ ...row, items })
})

// Fetch the most recent hourly rate for an employee (from their latest paie_item).
const lastRateStmt = db.prepare(`
  SELECT pi.hourly_rate
  FROM paie_items pi
  LEFT JOIN paies p ON p.id = pi.paie_id
  WHERE pi.employee_id = ? AND pi.hourly_rate IS NOT NULL
  ORDER BY COALESCE(p.period_end, pi.start_date) DESC
  LIMIT 1
`)

// Sum of declared regular hours from the employee's last 2 paie items.
// Used as the Quebec 1/20 holiday pay base (4 weeks = last 2 biweekly paies).
const last2HoursStmt = db.prepare(`
  SELECT COALESCE(SUM(regular_hours), 0) AS sum_h FROM (
    SELECT pi.regular_hours
    FROM paie_items pi
    LEFT JOIN paies p ON p.id = pi.paie_id
    WHERE pi.employee_id = ? AND pi.regular_hours IS NOT NULL
    ORDER BY COALESCE(p.period_end, pi.start_date) DESC
    LIMIT 2
  )
`)

router.post('/', ensureHR, (req, res) => {
  if (!req.body.period_end) return res.status(400).json({ error: 'Fin de période requise' })
  const holidayError = validateNbHolidayDays(req.body)
  if (holidayError) return res.status(400).json({ error: holidayError })
  const id = randomUUID()
  const cols = ['id', ...ALLOWED.filter(k => k in req.body)]
  const vals = [id, ...ALLOWED.filter(k => k in req.body).map(k => req.body[k] ?? null)]
  const placeholders = cols.map(() => '?').join(',')

  const nbHolidays = Number(req.body.nb_holiday_days) || 0
  const startDate = req.body.period_end || null

  const insertItem = db.prepare(`
    INSERT INTO paie_items (
      id, paie_id, employee_id, start_date, hourly_rate, regular_hours, holiday_1_20
    ) VALUES (?,?,?,?,?,?,?)
  `)

  const itemIds = db.transaction(() => {
    db.prepare(`INSERT INTO paies (${cols.join(',')}) VALUES (${placeholders})`).run(...vals)

    const employees = db.prepare(
      'SELECT id, hours_per_week FROM employees WHERE active = 1'
    ).all()

    let created = 0
    for (const emp of employees) {
      const hourlyRate = lastRateStmt.get(emp.id)?.hourly_rate ?? null

      // Biweekly regular hours; null for variable-schedule employees.
      let regularHours = emp.hours_per_week != null ? emp.hours_per_week * 2 : null

      // Quebec holiday pay: 1/20 × hours from last 2 paies × rate, × N holidays.
      let holiday_1_20 = null
      if (nbHolidays > 0 && hourlyRate != null) {
        const sumLast2 = last2HoursStmt.get(emp.id)?.sum_h || 0
        if (sumLast2 > 0) {
          holiday_1_20 = (sumLast2 / 20) * hourlyRate * nbHolidays
        }
      }

      // Each holiday reduces biweekly regular hours by 1/10 (= hours_per_week / 5).
      if (nbHolidays > 0 && regularHours != null) {
        regularHours -= nbHolidays * (emp.hours_per_week / 5)
        if (regularHours < 0) regularHours = 0
      }

      insertItem.run(
        randomUUID(), id, emp.id, startDate, hourlyRate, regularHours, holiday_1_20
      )
      created++
    }
    return created
  })()

  // Import automatique des heures depuis les feuilles de temps.
  // Pour les employés avec hours_per_week > 0 : garde regular_hours, enregistre le diff en banque.
  // Pour les autres : écrase regular_hours avec les heures payables de la période.
  let importResult = null
  try {
    importResult = importTimesheetsForPaie(id)
  } catch (e) {
    console.error('Import feuilles de temps (POST /paies):', e.message)
  }

  const paie = db.prepare('SELECT * FROM paies WHERE id=?').get(id)
  emitEntity('paie', 'created', id, buildPaieListRow(id), req.user?.id)
  res.status(201).json({ ...paie, items_created: itemIds, timesheet_import: importResult })
})

// POST /api/paies/:id/import-timesheets — resynchronisation manuelle (admin/rh)
router.post('/:id/import-timesheets', ensureHR, (req, res) => {
  const paie = db.prepare('SELECT id FROM paies WHERE id=?').get(req.params.id)
  if (!paie) return res.status(404).json({ error: 'Not found' })
  try {
    const result = importTimesheetsForPaie(req.params.id)
    emitEntity('paie', 'updated', req.params.id, buildPaieListRow(req.params.id), req.user?.id)
    res.json(result)
  } catch (e) {
    console.error('Import feuilles de temps:', e)
    res.status(500).json({ error: e.message })
  }
})

router.patch('/:id', ensureHR, (req, res) => {
  const existing = db.prepare('SELECT id FROM paies WHERE id=?').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })
  const holidayError = validateNbHolidayDays(req.body)
  if (holidayError) return res.status(400).json({ error: holidayError })
  const fields = ["updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"]
  const params = []
  for (const key of ALLOWED) {
    if (key in req.body) { fields.push(`${key}=?`); params.push(req.body[key] ?? null) }
  }
  db.prepare(`UPDATE paies SET ${fields.join(',')} WHERE id=?`).run(...params, req.params.id)
  const updated = db.prepare('SELECT * FROM paies WHERE id=?').get(req.params.id)
  emitEntity('paie', 'updated', req.params.id, buildPaieListRow(req.params.id), req.user?.id)
  res.json(updated)
})

router.delete('/:id', ensureHR, (req, res) => {
  const existing = db.prepare('SELECT id FROM paies WHERE id=?').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })
  // hour_bank_entries.paie_id n'a pas de ON DELETE — soft-delete + délier avant
  // de supprimer la paie pour éviter le FOREIGN KEY constraint failed.
  const tx = db.transaction((paieId) => {
    db.prepare(`
      UPDATE hour_bank_entries
         SET paie_id = NULL,
             paie_item_id = NULL,
             deleted_at = COALESCE(deleted_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE paie_id = ?
    `).run(paieId)
    db.prepare('DELETE FROM paies WHERE id=?').run(paieId)
  })
  try {
    tx(req.params.id)
    emitEntity('paie', 'deleted', req.params.id, { id: req.params.id }, req.user?.id)
    res.json({ ok: true })
  } catch (err) {
    console.error('paies DELETE failed', { id: req.params.id, error: err.message })
    res.status(500).json({ error: err.message })
  }
})

// Items list (for the paie_items table view)
router.get('/items/list', (req, res) => {
  const { q, page = 1, limit = 100 } = req.query
  const limitVal = parseInt(limit)
  const offset = (parseInt(page) - 1) * limitVal
  const hr = isHROrAdmin(req.user)
  const empId = hr ? null : myEmployeeId(req.user.id)
  if (!hr && !empId) return res.json({ data: [], total: 0, page: parseInt(page), limit: limitVal })
  const conditions = []
  const params = []
  if (q) {
    conditions.push('(e.first_name LIKE ? OR e.last_name LIKE ?)')
    const like = `%${q}%`
    params.push(like, like)
  }
  if (!hr) {
    conditions.push('pi.employee_id = ?')
    params.push(empId)
  }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''
  const total = db.prepare(`
    SELECT COUNT(*) c FROM paie_items pi LEFT JOIN employees e ON e.id=pi.employee_id ${where}
  `).get(...params).c
  const rows = db.prepare(`
    SELECT pi.*, e.first_name, e.last_name, e.matricule, e.accounting_department,
      p.period_end, p.number AS paie_number
    FROM paie_items pi
    LEFT JOIN employees e ON e.id = pi.employee_id
    LEFT JOIN paies p ON p.id = pi.paie_id
    ${where}
    ORDER BY p.period_end DESC, e.last_name, e.first_name
    LIMIT ? OFFSET ?
  `).all(...params, limitVal, offset)
  res.json({ data: rows, total, page: parseInt(page), limit: limitVal })
})

export default router
