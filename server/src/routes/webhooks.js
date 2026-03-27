import { Router } from 'express'
import { v4 as uuid } from 'uuid'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { newId } from '../utils/ids.js'

const router = Router()
router.use(requireAuth)

function validURL(url) {
  return typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'))
}

// GET /api/webhooks
router.get('/', (req, res) => {
  const webhooks = db.prepare(`
    SELECT w.*, t.name as table_name FROM webhooks w
    LEFT JOIN base_tables t ON w.table_id = t.id
    WHERE w.tenant_id = ? ORDER BY w.created_at DESC
  `).all(req.user.tenant_id)
  res.json(webhooks.map(w => ({ ...w, events: JSON.parse(w.events || '[]') })))
})

// POST /api/webhooks
router.post('/', (req, res) => {
  const { table_id, url, events, secret, enabled, name } = req.body
  const tid = req.user.tenant_id

  if (!validURL(url)) return res.status(400).json({ error: 'URL invalide (doit commencer par http:// ou https://)' })

  if (table_id) {
    const table = db.prepare('SELECT id FROM base_tables WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL').get(table_id, tid)
    if (!table) return res.status(400).json({ error: 'Table introuvable' })
  }

  const id = newId('webhook')
  const eventsArr = Array.isArray(events) ? events : ['record:created', 'record:updated', 'record:deleted']
  const active = enabled === false ? 0 : 1

  db.prepare(`
    INSERT INTO webhooks (id, tenant_id, table_id, name, url, events, active, secret)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, tid, table_id || null, name || url, url, JSON.stringify(eventsArr), active, secret || null)

  const created = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id)
  res.status(201).json({ ...created, events: eventsArr })
})

// PATCH /api/webhooks/:id
router.patch('/:id', (req, res) => {
  const wh = db.prepare('SELECT * FROM webhooks WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user.tenant_id)
  if (!wh) return res.status(404).json({ error: 'Introuvable' })

  const { url, events, secret, enabled, name } = req.body
  if (url !== undefined && !validURL(url)) return res.status(400).json({ error: 'URL invalide' })

  db.prepare(`
    UPDATE webhooks SET
      name = COALESCE(?, name),
      url = COALESCE(?, url),
      events = COALESCE(?, events),
      active = COALESCE(?, active),
      secret = COALESCE(?, secret),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    name !== undefined ? name : null,
    url !== undefined ? url : null,
    events !== undefined ? JSON.stringify(events) : null,
    enabled !== undefined ? (enabled ? 1 : 0) : null,
    secret !== undefined ? secret : null,
    req.params.id
  )

  const updated = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(req.params.id)
  res.json({ ...updated, events: JSON.parse(updated.events || '[]') })
})

// DELETE /api/webhooks/:id
router.delete('/:id', (req, res) => {
  const wh = db.prepare('SELECT id FROM webhooks WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user.tenant_id)
  if (!wh) return res.status(404).json({ error: 'Introuvable' })
  db.prepare('DELETE FROM webhooks WHERE id = ?').run(req.params.id)
  res.json({ success: true })
})

export default router
