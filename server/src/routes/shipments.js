import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

const ADDRESS_COLS = `
  s.address_id,
  a.line1 as address_line1, a.city as address_city,
  a.province as address_province, a.postal_code as address_postal_code,
  a.country as address_country
`

// GET /api/shipments
router.get('/', (req, res) => {
  const { search, status, order_id, page = 1, limit = 50 } = req.query
  const limitAll = limit === 'all'
  const limitVal = limitAll ? -1 : parseInt(limit)
  const offset = limitAll ? 0 : (parseInt(page) - 1) * parseInt(limit)
  const tid = req.user.tenant_id

  let where = 'WHERE s.tenant_id = ?'
  const params = [tid]

  if (search) {
    where += ' AND (s.tracking_number LIKE ? OR s.carrier LIKE ? OR CAST(o.order_number AS TEXT) LIKE ? OR c.name LIKE ?)'
    const q = `%${search}%`
    params.push(q, q, q, q)
  }
  if (status) {
    where += ' AND s.status = ?'
    params.push(status)
  }
  if (order_id) {
    where += ' AND s.order_id = ?'
    params.push(order_id)
  }

  const total = db.prepare(`
    SELECT COUNT(*) as c FROM shipments s
    LEFT JOIN orders o ON s.order_id = o.id
    LEFT JOIN companies c ON o.company_id = c.id
    ${where}
  `).get(...params).c

  const rows = db.prepare(`
    SELECT s.*, o.order_number, o.company_id, c.name as company_name, ${ADDRESS_COLS}
    FROM shipments s
    LEFT JOIN orders o ON s.order_id = o.id
    LEFT JOIN companies c ON o.company_id = c.id
    LEFT JOIN adresses a ON s.address_id = a.id
    ${where}
    ORDER BY s.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limitVal, offset)

  res.json({ data: rows, total, page: parseInt(page), limit: parseInt(limit) })
})

// GET /api/shipments/:id
router.get('/:id', (req, res) => {
  const row = db.prepare(`
    SELECT s.*, o.order_number, o.company_id, c.name as company_name, ${ADDRESS_COLS}
    FROM shipments s
    LEFT JOIN orders o ON s.order_id = o.id
    LEFT JOIN companies c ON o.company_id = c.id
    LEFT JOIN adresses a ON s.address_id = a.id
    WHERE s.id = ? AND s.tenant_id = ?
  `).get(req.params.id, req.user.tenant_id)

  if (!row) return res.status(404).json({ error: 'Envoi introuvable' })

  const order_items = db.prepare(`
    SELECT oi.*, pr.name_fr as product_name, pr.sku
    FROM order_items oi
    LEFT JOIN products pr ON oi.product_id = pr.id
    WHERE oi.order_id = ?
    ORDER BY oi.created_at
  `).all(row.order_id)

  res.json({ ...row, order_items })
})

// POST /api/shipments
router.post('/', (req, res) => {
  const { order_id, tracking_number, carrier, status, shipped_at, notes, address_id } = req.body
  if (!order_id) return res.status(400).json({ error: 'order_id est requis' })

  const tid = req.user.tenant_id
  const order = db.prepare('SELECT id FROM orders WHERE id = ? AND tenant_id = ?').get(order_id, tid)
  if (!order) return res.status(400).json({ error: 'Commande introuvable' })

  const id = uuidv4()
  db.prepare(`
    INSERT INTO shipments (id, tenant_id, order_id, tracking_number, carrier, status, shipped_at, notes, address_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, tid, order_id, tracking_number || null, carrier || null,
    status || 'À envoyer', shipped_at || null, notes || null, address_id || null)

  const created = db.prepare(`
    SELECT s.*, o.order_number, o.company_id, c.name as company_name, ${ADDRESS_COLS}
    FROM shipments s
    LEFT JOIN orders o ON s.order_id = o.id
    LEFT JOIN companies c ON o.company_id = c.id
    LEFT JOIN adresses a ON s.address_id = a.id
    WHERE s.id = ?
  `).get(id)

  res.status(201).json(created)
})

// PATCH /api/shipments/:id
router.patch('/:id', (req, res) => {
  const { tracking_number, carrier, status, shipped_at, notes, address_id } = req.body
  const tid = req.user.tenant_id

  const existing = db.prepare('SELECT id FROM shipments WHERE id = ? AND tenant_id = ?').get(req.params.id, tid)
  if (!existing) return res.status(404).json({ error: 'Envoi introuvable' })

  db.prepare(`
    UPDATE shipments SET
      tracking_number = COALESCE(?, tracking_number),
      carrier = COALESCE(?, carrier),
      status = COALESCE(?, status),
      shipped_at = COALESCE(?, shipped_at),
      notes = COALESCE(?, notes),
      address_id = CASE WHEN ? THEN ? ELSE address_id END
    WHERE id = ? AND tenant_id = ?
  `).run(
    tracking_number !== undefined ? tracking_number : null,
    carrier !== undefined ? carrier : null,
    status !== undefined ? status : null,
    shipped_at !== undefined ? shipped_at : null,
    notes !== undefined ? notes : null,
    address_id !== undefined ? 1 : 0, address_id !== undefined ? address_id : null,
    req.params.id, tid
  )

  const updated = db.prepare(`
    SELECT s.*, o.order_number, o.company_id, c.name as company_name, ${ADDRESS_COLS}
    FROM shipments s
    LEFT JOIN orders o ON s.order_id = o.id
    LEFT JOIN companies c ON o.company_id = c.id
    LEFT JOIN adresses a ON s.address_id = a.id
    WHERE s.id = ?
  `).get(req.params.id)

  res.json(updated)
})

// DELETE /api/shipments/:id
router.delete('/:id', (req, res) => {
  const tid = req.user.tenant_id
  const existing = db.prepare('SELECT id FROM shipments WHERE id = ? AND tenant_id = ?').get(req.params.id, tid)
  if (!existing) return res.status(404).json({ error: 'Envoi introuvable' })

  db.prepare('DELETE FROM shipments WHERE id = ? AND tenant_id = ?').run(req.params.id, tid)
  res.json({ success: true })
})

export default router
