import { Router } from 'express'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { parseLimit } from '../utils/pagination.js'

const router = Router()

router.use(requireAuth)

// GET /api/notifications — notifications de l'utilisateur courant, les plus
// récentes d'abord. `?unread=1` filtre sur non-lues. `?limit` borne (défaut 30).
// Renvoie aussi `unread_count` pour alimenter le badge en une seule requête.
router.get('/', (req, res) => {
  const { unread, limit = 30 } = req.query
  const limitVal = parseLimit(limit, { def: 30, max: 100 })
  const onlyUnread = unread === '1' || unread === 'true'

  const rows = db.prepare(`
    SELECT id, user_id, type, title, body, link, read, created_at
    FROM notifications
    WHERE user_id = ? ${onlyUnread ? 'AND read = 0' : ''}
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(req.user.id, limitVal)

  const unreadCount = db.prepare(
    'SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read = 0'
  ).get(req.user.id).c

  res.json({ data: rows, unread_count: unreadCount })
})

// GET /api/notifications/unread-count — compteur seul, pour le badge.
router.get('/unread-count', (req, res) => {
  const c = db.prepare(
    'SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read = 0'
  ).get(req.user.id).c
  res.json({ unread_count: c })
})

// PATCH /api/notifications/:id/read — marque une notification lue (ou non-lue
// si body { read: false }). Scopé à l'utilisateur courant : on ne peut pas
// toucher la notification d'un autre.
router.patch('/:id/read', (req, res) => {
  const notif = db.prepare(
    'SELECT id FROM notifications WHERE id = ? AND user_id = ?'
  ).get(req.params.id, req.user.id)
  if (!notif) return res.status(404).json({ error: 'Notification introuvable' })

  const readVal = req.body?.read === false ? 0 : 1
  db.prepare('UPDATE notifications SET read = ? WHERE id = ?').run(readVal, req.params.id)
  res.json({ id: req.params.id, read: readVal })
})

// POST /api/notifications/read-all — marque toutes les non-lues comme lues.
router.post('/read-all', (req, res) => {
  const r = db.prepare(
    'UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0'
  ).run(req.user.id)
  res.json({ marked: r.changes })
})

// DELETE /api/notifications/:id — retire une notification de la liste de
// l'utilisateur courant (suppression dure : ligne purement applicative, pas de
// valeur métier à conserver).
router.delete('/:id', (req, res) => {
  const r = db.prepare(
    'DELETE FROM notifications WHERE id = ? AND user_id = ?'
  ).run(req.params.id, req.user.id)
  if (!r.changes) return res.status(404).json({ error: 'Notification introuvable' })
  res.json({ deleted: req.params.id })
})

export default router
