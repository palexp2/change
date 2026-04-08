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
    SELECT p.*, pr.name_fr as product_name, pr.sku
    FROM purchases p
    LEFT JOIN products pr ON p.product_id = pr.id
    ${where}
    ORDER BY p.order_date DESC, p.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limitVal, offset)

  res.json({ data: purchases, total, page: parseInt(page), limit: parseInt(limit) })
})

router.get('/:id', (req, res) => {
  const purchase = db.prepare(`
    SELECT p.*, pr.name_fr as product_name, pr.sku, pr.image_url as product_image
    FROM purchases p
    LEFT JOIN products pr ON p.product_id = pr.id
    WHERE p.id = ?
  `).get(req.params.id)
  if (!purchase) return res.status(404).json({ error: 'Not found' })
  res.json(purchase)
})

export default router
