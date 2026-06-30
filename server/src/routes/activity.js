import { Router } from 'express'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()

router.use(requireAuth)

// Feed des opérations — journal d'activité paginé (qui / quoi / quand).
// Supporte ?limit=all (cf. CLAUDE.md) pour charger tout via loadProgressive.
router.get('/', (req, res) => {
  const { page = 1, limit = 100 } = req.query
  const limitAll = limit === 'all'
  const limitVal = limitAll ? -1 : parseInt(limit)
  const offset = limitAll ? 0 : (parseInt(page) - 1) * parseInt(limit)

  const total = db.prepare('SELECT COUNT(*) AS c FROM activity_log').get().c
  const rows = db.prepare(`
    SELECT a.id, a.user_id, a.entity_type, a.entity_id, a.action, a.detail, a.created_at,
           u.name AS user_name
    FROM activity_log a
    LEFT JOIN users u ON u.id = a.user_id
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT ? OFFSET ?
  `).all(limitVal, offset)

  res.json({ data: rows, total, page: parseInt(page), limit: limitAll ? 'all' : parseInt(limit) })
})

export default router
