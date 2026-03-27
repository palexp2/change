import { Router } from 'express'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

// GET /api/notifications
router.get('/', (req, res) => {
  const { unread_only, limit = 20, page = 1 } = req.query
  const uid = req.user.id
  const tid = req.user.tenant_id

  const lim = Math.min(parseInt(limit) || 20, 100)
  const off = (Math.max(parseInt(page), 1) - 1) * lim

  let where = 'WHERE user_id = ? AND tenant_id = ?'
  const params = [uid, tid]

  if (unread_only === 'true' || unread_only === '1') {
    where += ' AND read = 0'
  }

  const total = db.prepare(`SELECT COUNT(*) as c FROM notifications ${where}`).get(...params).c
  const unread_count = db.prepare('SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND tenant_id = ? AND read = 0').get(uid, tid).c
  const data = db.prepare(`SELECT * FROM notifications ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, lim, off)

  res.json({ data, total, unread_count, page: parseInt(page), limit: lim })
})

// PATCH /api/notifications/:id/read
router.patch('/:id/read', (req, res) => {
  const notif = db.prepare('SELECT id FROM notifications WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id)
  if (!notif) return res.status(404).json({ error: 'Introuvable' })
  db.prepare("UPDATE notifications SET read = 1, read_at = datetime('now') WHERE id = ?").run(req.params.id)
  res.json({ success: true })
})

// POST /api/notifications/read-all
router.post('/read-all', (req, res) => {
  const result = db.prepare("UPDATE notifications SET read = 1, read_at = datetime('now') WHERE user_id = ? AND tenant_id = ? AND read = 0")
    .run(req.user.id, req.user.tenant_id)
  res.json({ updated: result.changes })
})

export default router
