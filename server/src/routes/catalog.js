import { Router } from 'express'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

// Returns all sellable products (is_sellable = 1) from the products table
router.get('/', (req, res) => {
  const tid = req.user.tenant_id
  const rows = db.prepare(`
    SELECT * FROM products
    WHERE tenant_id = ? AND is_sellable = 1 AND active = 1
    ORDER BY sku, name_fr
  `).all(tid)
  res.json(rows)
})

export default router
