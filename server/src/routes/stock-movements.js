import { Router } from 'express'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

router.get('/', (req, res) => {
  const { type, reason, product_id, page = 1, limit = 50 } = req.query
  const limitAll = limit === 'all'
  const limitVal = limitAll ? -1 : parseInt(limit)
  const offset = limitAll ? 0 : (parseInt(page) - 1) * parseInt(limit)

  let where = ''
  const params = []
  const add = (cond, val) => { where += (where ? ' AND' : ' WHERE') + ' ' + cond; params.push(val) }
  if (type) add('sm.type = ?', type)
  if (reason) add('sm.reason = ?', reason)
  if (product_id) add('sm.product_id = ?', product_id)

  const total = db.prepare(`SELECT COUNT(*) as c FROM stock_movements sm ${where}`).get(...params).c
  const rows = db.prepare(`
    SELECT sm.*,
           p.sku      AS product_sku,
           p.name_fr  AS product_name,
           u.name     AS user_name
    FROM stock_movements sm
    LEFT JOIN products p ON sm.product_id = p.id
    LEFT JOIN users    u ON sm.user_id = u.id
    ${where}
    ORDER BY sm.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limitVal, offset)

  res.json({ data: rows, total, page: parseInt(page), limit: parseInt(limit) })
})

export default router
