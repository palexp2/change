import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

// GET /api/hour-bank — solde par employé (vue agrégée)
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT e.id as employee_id,
           e.first_name, e.last_name, e.matricule, e.active,
           COALESCE(SUM(hb.hours), 0) as balance_hours,
           COUNT(hb.id) as entry_count,
           MAX(hb.date) as last_entry_date
    FROM employees e
    LEFT JOIN hour_bank_entries hb ON hb.employee_id = e.id AND hb.deleted_at IS NULL
    WHERE (e.active = 1 OR hb.id IS NOT NULL)
    GROUP BY e.id
    HAVING COUNT(hb.id) > 0 OR e.active = 1
    ORDER BY e.last_name, e.first_name
  `).all()
  res.json({ data: rows })
})

// GET /api/hour-bank/:employeeId — historique des ajustements pour un employé
router.get('/:employeeId', (req, res) => {
  const employee = db.prepare('SELECT id, first_name, last_name, matricule FROM employees WHERE id = ?').get(req.params.employeeId)
  if (!employee) return res.status(404).json({ error: 'Employé introuvable' })
  const entries = db.prepare(`
    SELECT hb.*, p.number as paie_number, p.period_end as paie_period_end
    FROM hour_bank_entries hb
    LEFT JOIN paies p ON hb.paie_id = p.id
    WHERE hb.employee_id = ? AND hb.deleted_at IS NULL
    ORDER BY hb.date DESC, hb.created_at DESC
  `).all(req.params.employeeId)
  const balance = entries.reduce((s, e) => s + (Number(e.hours) || 0), 0)
  res.json({ employee, entries, balance_hours: Math.round(balance * 100) / 100 })
})

// POST /api/hour-bank — ajustement manuel
router.post('/', (req, res) => {
  const { employee_id, date, hours, notes } = req.body || {}
  if (!employee_id) return res.status(400).json({ error: 'employee_id requis' })
  if (hours === undefined || hours === null || isNaN(Number(hours))) return res.status(400).json({ error: 'hours requis (nombre)' })
  if (!date) return res.status(400).json({ error: 'date requise' })
  const employee = db.prepare('SELECT id FROM employees WHERE id = ?').get(employee_id)
  if (!employee) return res.status(400).json({ error: 'Employé introuvable' })
  const id = uuidv4()
  db.prepare(`
    INSERT INTO hour_bank_entries (id, employee_id, date, hours, source, notes)
    VALUES (?, ?, ?, ?, 'manual', ?)
  `).run(id, employee_id, date, Number(hours), notes || null)
  res.status(201).json(db.prepare('SELECT * FROM hour_bank_entries WHERE id = ?').get(id))
})

const PATCHABLE = new Set(['hours', 'date', 'notes'])

router.patch('/entry/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM hour_bank_entries WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })
  const updates = []
  const params = []
  for (const [k, rawV] of Object.entries(req.body || {})) {
    if (!PATCHABLE.has(k)) continue
    let v = rawV
    if (k === 'hours') {
      if (v === '' || v === null || v === undefined || isNaN(Number(v))) return res.status(400).json({ error: 'hours invalide' })
      v = Number(v)
    } else if (v === '' || v === undefined) v = null
    updates.push(`${k} = ?`)
    params.push(v)
  }
  if (!updates.length) return res.status(400).json({ error: 'Aucun champ modifiable fourni' })
  updates.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
  params.push(req.params.id)
  db.prepare(`UPDATE hour_bank_entries SET ${updates.join(', ')} WHERE id = ?`).run(...params)
  res.json(db.prepare('SELECT * FROM hour_bank_entries WHERE id = ?').get(req.params.id))
})

router.delete('/entry/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM hour_bank_entries WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })
  db.prepare(`UPDATE hour_bank_entries SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(req.params.id)
  res.json({ success: true })
})

export default router
