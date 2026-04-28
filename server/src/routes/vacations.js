import { Router } from 'express'
import { randomUUID } from 'crypto'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

router.get('/', (req, res) => {
  const { employee_id } = req.query
  let rows
  if (employee_id) {
    rows = db.prepare(`
      SELECT * FROM vacations
      WHERE employee_id = ?
      ORDER BY COALESCE(start_date, '') DESC, created_at DESC
    `).all(employee_id)
  } else {
    rows = db.prepare(`
      SELECT * FROM vacations
      ORDER BY COALESCE(start_date, '') DESC, created_at DESC
    `).all()
  }
  res.json({ data: rows })
})

router.post('/', (req, res) => {
  const { employee_id, start_date, end_date, paid, notes } = req.body || {}
  if (!employee_id) return res.status(400).json({ error: 'employee_id requis' })
  const emp = db.prepare('SELECT id FROM employees WHERE id = ?').get(employee_id)
  if (!emp) return res.status(400).json({ error: 'Employé introuvable' })
  const id = randomUUID()
  db.prepare(`
    INSERT INTO vacations (id, employee_id, start_date, end_date, paid, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id,
    employee_id,
    start_date || null,
    end_date || null,
    paid === 0 || paid === false ? 0 : 1,
    notes || null,
  )
  res.status(201).json(db.prepare('SELECT * FROM vacations WHERE id = ?').get(id))
})

const PATCHABLE = new Set(['start_date', 'end_date', 'paid', 'notes'])

router.patch('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM vacations WHERE id = ?').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })
  const updates = []
  const params = []
  for (const [k, rawV] of Object.entries(req.body || {})) {
    if (!PATCHABLE.has(k)) continue
    let v = rawV
    if (k === 'paid') {
      v = v === 0 || v === false || v === '0' ? 0 : 1
    } else if (v === '' || v === undefined) {
      v = null
    }
    updates.push(`${k} = ?`)
    params.push(v)
  }
  if (!updates.length) return res.status(400).json({ error: 'Aucun champ modifiable fourni' })
  updates.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
  params.push(req.params.id)
  db.prepare(`UPDATE vacations SET ${updates.join(', ')} WHERE id = ?`).run(...params)
  res.json(db.prepare('SELECT * FROM vacations WHERE id = ?').get(req.params.id))
})

router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM vacations WHERE id = ?').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })
  db.prepare('DELETE FROM vacations WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
})

export default router
