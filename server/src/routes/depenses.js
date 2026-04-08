import { Router } from 'express'
import { randomUUID } from 'crypto'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

router.get('/', (req, res) => {
  const { status, category, vendor_id, page = 1, limit = 50 } = req.query
  const limitAll = limit === 'all'
  const limitVal = limitAll ? -1 : parseInt(limit)
  const offset = limitAll ? 0 : (parseInt(page) - 1) * parseInt(limit)
  let where = ''
  const params = []

  if (status) { where += (where ? ' AND' : ' WHERE') + ' d.status = ?'; params.push(status) }
  if (category) { where += (where ? ' AND' : ' WHERE') + ' d.category = ?'; params.push(category) }
  if (vendor_id) { where += (where ? ' AND' : ' WHERE') + ' d.vendor_id = ?'; params.push(vendor_id) }

  const total = db.prepare(`SELECT COUNT(*) as c FROM depenses d ${where}`).get(...params).c
  const rows = db.prepare(`
    SELECT d.*, u.name as created_by_name
    FROM depenses d
    LEFT JOIN users u ON d.created_by = u.id
    ${where}
    ORDER BY d.date_depense DESC, d.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limitVal, offset)

  res.json({ data: rows, total, page: parseInt(page), limit: parseInt(limit) })
})

router.get('/:id', (req, res) => {
  const row = db.prepare(`
    SELECT d.*, u.name as created_by_name
    FROM depenses d
    LEFT JOIN users u ON d.created_by = u.id
    WHERE d.id = ?
  `).get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  res.json(row)
})

router.post('/', (req, res) => {
  const { date_depense, category, description, vendor, vendor_id, reference, amount_cad, tax_cad, payment_method, status, notes } = req.body
  if (!date_depense || !description) return res.status(400).json({ error: 'date_depense et description sont requis' })

  const id = randomUUID()
  db.prepare(`
    INSERT INTO depenses (id, date_depense, category, description, vendor, vendor_id, reference, amount_cad, tax_cad, payment_method, status, created_by, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, date_depense, category || null, description, vendor || null, vendor_id || null,
    reference || null, amount_cad || 0, tax_cad || 0, payment_method || null, status || 'Brouillon', req.user.id, notes || null)

  res.status(201).json(db.prepare('SELECT * FROM depenses WHERE id = ?').get(id))
})

router.put('/:id', (req, res) => {
  const { date_depense, category, description, vendor, vendor_id, reference, amount_cad, tax_cad, payment_method, status, notes } = req.body
  const existing = db.prepare('SELECT id FROM depenses WHERE id = ?').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })

  db.prepare(`
    UPDATE depenses SET date_depense=?, category=?, description=?, vendor=?, vendor_id=?, reference=?, amount_cad=?, tax_cad=?, payment_method=?, status=?, notes=?, updated_at=datetime('now')
    WHERE id = ?
  `).run(date_depense, category || null, description, vendor || null, vendor_id || null, reference || null,
    amount_cad || 0, tax_cad || 0, payment_method || null, status || 'Brouillon', notes || null,
    req.params.id)

  res.json(db.prepare('SELECT * FROM depenses WHERE id = ?').get(req.params.id))
})

router.patch('/:id/status', (req, res) => {
  const { status } = req.body
  const existing = db.prepare('SELECT id FROM depenses WHERE id = ?').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })

  db.prepare(`UPDATE depenses SET status=?, updated_at=datetime('now') WHERE id = ?`)
    .run(status, req.params.id)
  res.json({ ok: true })
})

router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM depenses WHERE id = ?').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })
  db.prepare('DELETE FROM depenses WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
})

export default router
