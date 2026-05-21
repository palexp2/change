import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import db from '../db/database.js'
import { requireAuth, isHROrAdmin } from '../middleware/auth.js'
import { emitEntity } from '../services/realtimeEmitters.js'

const router = Router()
router.use(requireAuth)

function myEmployeeId(userId) {
  const row = db.prepare('SELECT employee_id FROM users WHERE id = ?').get(userId)
  return row?.employee_id || null
}

// GET /api/hour-bank — admin/rh : solde par employé (vue agrégée).
// Autres rôles : uniquement leur propre ligne (si lié à un employé).
router.get('/', (req, res) => {
  if (isHROrAdmin(req.user)) {
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
    return res.json({ data: rows })
  }
  const empId = myEmployeeId(req.user.id)
  if (!empId) return res.json({ data: [] })
  const row = db.prepare(`
    SELECT e.id as employee_id,
           e.first_name, e.last_name, e.matricule, e.active,
           COALESCE(SUM(hb.hours), 0) as balance_hours,
           COUNT(hb.id) as entry_count,
           MAX(hb.date) as last_entry_date
    FROM employees e
    LEFT JOIN hour_bank_entries hb ON hb.employee_id = e.id AND hb.deleted_at IS NULL
    WHERE e.id = ?
    GROUP BY e.id
  `).get(empId)
  res.json({ data: row ? [row] : [] })
})

// GET /api/hour-bank/:employeeId — historique des ajustements pour un employé.
// Restreint à admin/rh ou au user dont l'employee_id correspond.
router.get('/:employeeId', (req, res) => {
  if (!isHROrAdmin(req.user) && myEmployeeId(req.user.id) !== req.params.employeeId) {
    return res.status(403).json({ error: 'Accès refusé' })
  }
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

function ensureHR(req, res, next) {
  if (!isHROrAdmin(req.user)) return res.status(403).json({ error: 'Accès RH requis' })
  next()
}

// POST /api/hour-bank — ajustement manuel (admin/rh)
router.post('/', ensureHR, (req, res) => {
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
  const row = db.prepare('SELECT * FROM hour_bank_entries WHERE id = ?').get(id)
  emitEntity('hour_bank_entry', 'created', id, row, req.user?.id)
  res.status(201).json(row)
})

const PATCHABLE = new Set(['hours', 'date', 'notes'])

router.patch('/entry/:id', ensureHR, (req, res) => {
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
  const updated = db.prepare('SELECT * FROM hour_bank_entries WHERE id = ?').get(req.params.id)
  emitEntity('hour_bank_entry', 'updated', req.params.id, updated, req.user?.id)
  res.json(updated)
})

router.delete('/entry/:id', ensureHR, (req, res) => {
  const existing = db.prepare('SELECT id FROM hour_bank_entries WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })
  db.prepare(`UPDATE hour_bank_entries SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(req.params.id)
  emitEntity('hour_bank_entry', 'deleted', req.params.id, { id: req.params.id }, req.user?.id)
  res.json({ success: true })
})

export default router
