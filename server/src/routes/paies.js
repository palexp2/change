import { Router } from 'express'
import { randomUUID } from 'crypto'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { importTimesheetsForPaie } from '../services/paieTimesheetImport.js'

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
  let where = ''
  const params = []
  if (q) {
    where = 'WHERE (p.status LIKE ? OR CAST(p.number AS TEXT) LIKE ?)'
    const like = `%${q}%`
    params.push(like, like)
  }

  const total = db.prepare(`SELECT COUNT(*) c FROM paies p ${where}`).get(...params).c
  const rows = db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM paie_items WHERE paie_id = p.id) AS items_count,
      (SELECT SUM(regular_hours) FROM paie_items WHERE paie_id = p.id) AS total_regular_hours,
      (SELECT SUM(COALESCE(regular_hours,0) * COALESCE(hourly_rate,0)) FROM paie_items WHERE paie_id = p.id) AS total_regular_amount
    FROM paies p
    ${where}
    ORDER BY p.period_end DESC, p.number DESC
    LIMIT ? OFFSET ?
  `).all(...params, limitVal, offset)

  res.json({ data: rows, total, page: parseInt(page), limit: limitVal })
})

router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM paies WHERE id=?').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  const items = db.prepare(`
    SELECT pi.*, e.first_name, e.last_name, e.matricule, e.accounting_department
    FROM paie_items pi
    LEFT JOIN employees e ON e.id = pi.employee_id
    WHERE pi.paie_id = ?
    ORDER BY e.last_name, e.first_name
  `).all(req.params.id)
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

router.post('/', (req, res) => {
  if (!req.body.period_end) return res.status(400).json({ error: 'Fin de période requise' })
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
  res.status(201).json({ ...paie, items_created: itemIds, timesheet_import: importResult })
})

// POST /api/paies/:id/import-timesheets — resynchronisation manuelle
router.post('/:id/import-timesheets', (req, res) => {
  const paie = db.prepare('SELECT id FROM paies WHERE id=?').get(req.params.id)
  if (!paie) return res.status(404).json({ error: 'Not found' })
  try {
    const result = importTimesheetsForPaie(req.params.id)
    res.json(result)
  } catch (e) {
    console.error('Import feuilles de temps:', e)
    res.status(500).json({ error: e.message })
  }
})

router.patch('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM paies WHERE id=?').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })
  const fields = ["updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"]
  const params = []
  for (const key of ALLOWED) {
    if (key in req.body) { fields.push(`${key}=?`); params.push(req.body[key] ?? null) }
  }
  db.prepare(`UPDATE paies SET ${fields.join(',')} WHERE id=?`).run(...params, req.params.id)
  res.json(db.prepare('SELECT * FROM paies WHERE id=?').get(req.params.id))
})

router.delete('/:id', (req, res) => {
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
  let where = ''
  const params = []
  if (q) {
    where = 'WHERE (e.first_name LIKE ? OR e.last_name LIKE ?)'
    const like = `%${q}%`
    params.push(like, like)
  }
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
