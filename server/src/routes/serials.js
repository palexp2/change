import { Router } from 'express'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

router.get('/', (req, res) => {
  const { company_id, product_id, status, search, page = 1, limit = 50 } = req.query
  const limitAll = limit === 'all'
  const limitVal = limitAll ? -1 : parseInt(limit)
  const offset = limitAll ? 0 : (parseInt(page) - 1) * parseInt(limit)
  const tid = req.user.tenant_id

  let where = 'WHERE sn.tenant_id = ?'
  const params = [tid]

  if (company_id) { where += ' AND sn.company_id = ?'; params.push(company_id) }
  if (product_id) { where += ' AND sn.product_id = ?'; params.push(product_id) }
  if (status) { where += ' AND sn.status = ?'; params.push(status) }
  if (search) {
    where += ' AND (sn.serial LIKE ? OR pr.name_fr LIKE ? OR co.name LIKE ?)'
    const q = `%${search}%`
    params.push(q, q, q)
  }

  const total = db.prepare(`
    SELECT COUNT(*) as c FROM serial_numbers sn
    LEFT JOIN products pr ON sn.product_id = pr.id
    LEFT JOIN companies co ON sn.company_id = co.id
    ${where}
  `).get(...params).c

  const serials = db.prepare(`
    SELECT sn.*, pr.name_fr as product_name, pr.sku, co.name as company_name
    FROM serial_numbers sn
    LEFT JOIN products pr ON sn.product_id = pr.id
    LEFT JOIN companies co ON sn.company_id = co.id
    ${where}
    ORDER BY sn.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limitVal, offset)

  res.json({ data: serials, total, page: parseInt(page), limit: parseInt(limit) })
})

router.get('/:id', (req, res) => {
  const serial = db.prepare(`
    SELECT sn.*, pr.name_fr as product_name, pr.sku, co.name as company_name
    FROM serial_numbers sn
    LEFT JOIN products pr ON sn.product_id = pr.id
    LEFT JOIN companies co ON sn.company_id = co.id
    WHERE sn.id = ? AND sn.tenant_id = ?
  `).get(req.params.id, req.user.tenant_id)
  if (!serial) return res.status(404).json({ error: 'Not found' })
  res.json(serial)
})

export default router
