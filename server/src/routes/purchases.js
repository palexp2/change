import { Router } from 'express'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

router.get('/', (req, res) => {
  const { status, product_id, page = 1, limit = 50 } = req.query
  const limitAll = limit === 'all'
  const limitVal = limitAll ? -1 : parseInt(limit)
  const offset = limitAll ? 0 : (parseInt(page) - 1) * parseInt(limit)
  let where = 'WHERE 1=1'
  const params = []

  if (status) { where += ' AND p.status = ?'; params.push(status) }
  if (product_id) { where += ' AND p.product_id = ?'; params.push(product_id) }

  const total = db.prepare(`SELECT COUNT(*) as c FROM purchases p ${where}`).get(...params).c
  const purchases = db.prepare(`
    SELECT p.*, pr.name_fr as product_name, pr.sku, pr.image_url as product_image,
           c.name as supplier_company_name
    FROM purchases p
    LEFT JOIN products pr ON p.product_id = pr.id
    LEFT JOIN companies c ON p.supplier_company_id = c.id
    ${where}
    ORDER BY p.order_date DESC, p.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limitVal, offset)

  res.json({ data: purchases, total, page: parseInt(page), limit: parseInt(limit) })
})

router.get('/:id', (req, res) => {
  const purchase = db.prepare(`
    SELECT p.*, pr.name_fr as product_name, pr.sku, pr.image_url as product_image,
           c.name as supplier_company_name
    FROM purchases p
    LEFT JOIN products pr ON p.product_id = pr.id
    LEFT JOIN companies c ON p.supplier_company_id = c.id
    WHERE p.id = ?
  `).get(req.params.id)
  if (!purchase) return res.status(404).json({ error: 'Not found' })
  res.json(purchase)
})

// Colonnes éditables via PATCH. Toute autre clé du body est ignorée.
const PATCHABLE_FIELDS = new Set([
  'status',
  'qty_ordered',
  'qty_received',
  'unit_cost',
  'order_date',
  'expected_date',
  'received_date',
  'reference',
  'supplier',
  'supplier_company_id',
  'emplacement',
  'notes',
])

router.patch('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM purchases WHERE id = ?').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })

  const updates = []
  const params = []
  for (const [key, raw] of Object.entries(req.body || {})) {
    if (!PATCHABLE_FIELDS.has(key)) continue
    let value = raw
    if (value === '' || value === undefined) value = null
    if (['qty_ordered', 'qty_received'].includes(key) && value !== null) {
      const n = parseInt(value, 10)
      if (Number.isNaN(n)) return res.status(400).json({ error: `${key} doit être un entier` })
      value = n
    }
    if (key === 'unit_cost' && value !== null) {
      const n = parseFloat(value)
      if (Number.isNaN(n)) return res.status(400).json({ error: 'unit_cost doit être un nombre' })
      value = n
    }
    updates.push(`${key} = ?`)
    params.push(value)
  }
  if (updates.length === 0) return res.status(400).json({ error: 'Aucun champ modifiable fourni' })

  updates.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
  params.push(req.params.id)
  db.prepare(`UPDATE purchases SET ${updates.join(', ')} WHERE id = ?`).run(...params)

  const updated = db.prepare(`
    SELECT p.*, pr.name_fr as product_name, pr.sku, pr.image_url as product_image,
           c.name as supplier_company_name
    FROM purchases p
    LEFT JOIN products pr ON p.product_id = pr.id
    LEFT JOIN companies c ON p.supplier_company_id = c.id
    WHERE p.id = ?
  `).get(req.params.id)
  res.json(updated)
})

router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM purchases WHERE id = ?').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })
  db.prepare('DELETE FROM purchases WHERE id = ?').run(req.params.id)
  res.json({ success: true })
})

export default router
