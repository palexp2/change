import { Router } from 'express'
import { randomUUID } from 'crypto'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

router.get('/', (req, res) => {
  const { q, page = 1, limit = 50 } = req.query
  const limitVal = parseInt(limit)
  const offset = (parseInt(page) - 1) * limitVal
  let where = ''
  const params = []
  if (q) {
    where = 'WHERE (first_name LIKE ? OR last_name LIKE ? OR email_work LIKE ? OR matricule LIKE ?)'
    const like = `%${q}%`
    params.push(like, like, like, like)
  }

  const total = db.prepare(`SELECT COUNT(*) as c FROM employees ${where}`).get(...params).c
  const rows = db.prepare(`
    SELECT * FROM employees ${where}
    ORDER BY last_name ASC, first_name ASC
    LIMIT ? OFFSET ?
  `).all(...params, limitVal, offset)

  res.json({ data: rows, total, page: parseInt(page), limit: limitVal })
})

router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM employees WHERE id=?')
    .get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  res.json(row)
})

router.post('/', (req, res) => {
  const { first_name, last_name, phone_personal, phone_work, email_personal, email_work, birth_date, hire_date, matricule } = req.body
  if (!first_name || !last_name) return res.status(400).json({ error: 'Prénom et nom requis' })
  const id = randomUUID()
  db.prepare(`
    INSERT INTO employees (id, first_name, last_name, phone_personal, phone_work, email_personal, email_work, birth_date, hire_date, matricule)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(id, first_name, last_name, phone_personal || null, phone_work || null, email_personal || null, email_work || null, birth_date || null, hire_date || null, matricule || null)
  res.status(201).json(db.prepare('SELECT * FROM employees WHERE id=?').get(id))
})

router.patch('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM employees WHERE id=?').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })

  const fields = ["updated_at=datetime('now')"]
  const params = []
  const allowed = ['first_name', 'last_name', 'phone_personal', 'phone_work', 'email_personal', 'email_work', 'birth_date', 'hire_date', 'matricule']
  for (const key of allowed) {
    if (key in req.body) { fields.push(`${key}=?`); params.push(req.body[key] ?? null) }
  }

  db.prepare(`UPDATE employees SET ${fields.join(',')} WHERE id=?`).run(...params, req.params.id)
  res.json(db.prepare('SELECT * FROM employees WHERE id=?').get(req.params.id))
})

router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM employees WHERE id=?').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })
  db.prepare('DELETE FROM employees WHERE id=?').run(req.params.id)
  res.json({ ok: true })
})

export default router
