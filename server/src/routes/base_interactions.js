import { Router } from 'express'
import { mkdirSync } from 'fs'
import { join } from 'path'
import multer from 'multer'
import { requireAuth } from '../middleware/auth.js'
import db from '../db/database.js'
import { newId } from '../utils/ids.js'
import { sanitizeHtml } from '../utils/sanitizeHtml.js'
import { autoMatchContacts } from '../services/interactionMatcher.js'
import { syncInteractions } from '../services/connectorSync.js'
import { broadcast } from '../services/realtime.js'
import { encryptCredentials, decryptCredentials } from '../utils/encryption.js'
import { connectors } from '../services/connectors/index.js'

const router = Router()
router.use(requireAuth)

// ── Attachment upload ─────────────────────────────────────────────────────────

const uploadsBase = join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'interactions')

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = join(uploadsBase, req.user.tenant_id, req.params.id)
    mkdirSync(dir, { recursive: true })
    cb(null, dir)
  },
  filename: (req, file, cb) => cb(null, `${newId('ita')}_${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`),
})
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } })

// ── Helpers ───────────────────────────────────────────────────────────────────

function enrichInteraction(interaction) {
  if (!interaction) return null
  interaction.links = db.prepare(`
    SELECT il.*, bt.name as table_name, bt.icon as table_icon, bt.slug as table_slug,
           json_extract(br.data, '$.' || (SELECT key FROM base_fields WHERE table_id = bt.id AND is_primary = 1 LIMIT 1)) as primary_value
    FROM base_interaction_links il
    LEFT JOIN base_tables bt ON il.table_id = bt.id
    LEFT JOIN base_records br ON il.record_id = br.id
    WHERE il.interaction_id = ?
  `).all(interaction.id)
  interaction.attachments = db.prepare(
    'SELECT * FROM base_interaction_attachments WHERE interaction_id = ?'
  ).all(interaction.id)
  return interaction
}

// ── GET /api/base/interactions ─────────────────────────────────────────────────

router.get('/', (req, res) => {
  const { type, direction, source, user_id, search, date_from, date_to, limit = 20, page = 1 } = req.query
  const tenantId = req.user.tenant_id

  let query = `
    SELECT i.*, u.name as user_name
    FROM base_interactions i
    LEFT JOIN users u ON i.user_id = u.id
    WHERE i.tenant_id = ? AND i.deleted_at IS NULL
  `
  const params = [tenantId]

  if (type) { query += ' AND i.type = ?'; params.push(type) }
  if (direction) { query += ' AND i.direction = ?'; params.push(direction) }
  if (source) { query += ' AND i.source = ?'; params.push(source) }
  if (user_id) { query += ' AND i.user_id = ?'; params.push(user_id) }
  if (search) { query += ' AND (i.subject LIKE ? OR i.body LIKE ?)'; params.push(`%${search}%`, `%${search}%`) }
  if (date_from) { query += ' AND COALESCE(i.completed_at, i.created_at) >= ?'; params.push(date_from) }
  if (date_to) { query += ' AND COALESCE(i.completed_at, i.created_at) <= ?'; params.push(date_to) }

  const countQuery = query.replace('SELECT i.*, u.name as user_name', 'SELECT COUNT(*) as total')
  const total = db.prepare(countQuery).get(...params).total

  query += ' ORDER BY COALESCE(i.completed_at, i.created_at) DESC LIMIT ? OFFSET ?'
  params.push(Math.min(Number(limit), 100), (Number(page) - 1) * Number(limit))

  const interactions = db.prepare(query).all(...params).map(enrichInteraction)
  res.json({ data: interactions, total, page: Number(page), limit: Number(limit) })
})

// ── GET /api/base/interactions/stats ──────────────────────────────────────────

router.get('/stats', (req, res) => {
  const { period = 'month', user_id, table_id, record_id } = req.query
  const tenantId = req.user.tenant_id

  const periodMap = { week: '-7 days', month: '-30 days', quarter: '-90 days' }
  const dateOffset = periodMap[period] || '-30 days'

  let baseWhere = "i.tenant_id = ? AND i.deleted_at IS NULL AND COALESCE(i.completed_at, i.created_at) >= datetime('now', ?)"
  const baseParams = [tenantId, dateOffset]

  if (user_id) { baseWhere += ' AND i.user_id = ?'; baseParams.push(user_id) }

  let joinClause = ''
  if (record_id || table_id) {
    joinClause = ' JOIN base_interaction_links il ON il.interaction_id = i.id'
    if (record_id) { baseWhere += ' AND il.record_id = ?'; baseParams.push(record_id) }
    if (table_id) { baseWhere += ' AND il.table_id = ?'; baseParams.push(table_id) }
  }

  const by_type = db.prepare(`SELECT i.type, COUNT(*) as count FROM base_interactions i ${joinClause} WHERE ${baseWhere} GROUP BY i.type`).all(...baseParams)
  const by_direction = db.prepare(`SELECT i.direction, COUNT(*) as count FROM base_interactions i ${joinClause} WHERE ${baseWhere} AND i.direction IS NOT NULL GROUP BY i.direction`).all(...baseParams)
  const by_user = db.prepare(`SELECT i.user_id, u.name, COUNT(*) as count FROM base_interactions i ${joinClause} LEFT JOIN users u ON i.user_id = u.id WHERE ${baseWhere} GROUP BY i.user_id`).all(...baseParams)
  const timeline = db.prepare(`SELECT date(COALESCE(i.completed_at, i.created_at)) as date, COUNT(*) as count FROM base_interactions i ${joinClause} WHERE ${baseWhere} GROUP BY date ORDER BY date ASC`).all(...baseParams)

  res.json({
    by_type: Object.fromEntries(by_type.map(r => [r.type, r.count])),
    by_direction: Object.fromEntries(by_direction.map(r => [r.direction, r.count])),
    by_user,
    timeline,
  })
})

// ── POST /api/base/interactions/sync ──────────────────────────────────────────

router.post('/sync', (req, res) => {
  const { interactions: incoming } = req.body
  if (!Array.isArray(incoming)) return res.status(400).json({ error: 'interactions array required' })
  try {
    const result = syncInteractions(db, req.user.tenant_id, incoming)
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── GET /api/base/interactions/:id ────────────────────────────────────────────

router.get('/:id', (req, res) => {
  const itr = db.prepare(`
    SELECT i.*, u.name as user_name FROM base_interactions i
    LEFT JOIN users u ON i.user_id = u.id
    WHERE i.id = ? AND i.tenant_id = ? AND i.deleted_at IS NULL
  `).get(req.params.id, req.user.tenant_id)
  if (!itr) return res.status(404).json({ error: 'Introuvable' })
  res.json(enrichInteraction(itr))
})

// ── POST /api/base/interactions ───────────────────────────────────────────────

router.post('/', (req, res) => {
  const {
    type, direction, subject, body, body_html, status, duration_seconds,
    phone_number, from_address, to_addresses, cc_addresses, bcc_addresses,
    thread_id, scheduled_at, completed_at, links,
  } = req.body

  if (!type) return res.status(400).json({ error: 'type requis' })

  const id = newId('int')
  const tenantId = req.user.tenant_id
  const sanitizedHtml = body_html ? sanitizeHtml(body_html) : null
  const finalStatus = status || (scheduled_at ? 'scheduled' : 'completed')
  const finalCompletedAt = completed_at || (finalStatus === 'completed' ? new Date().toISOString() : null)

  const transaction = db.transaction(() => {
    db.prepare(`
      INSERT INTO base_interactions (id, tenant_id, type, direction, subject, body, body_html, status,
        duration_seconds, phone_number, from_address, to_addresses, cc_addresses, bcc_addresses,
        thread_id, source, user_id, scheduled_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?)
    `).run(id, tenantId, type, direction || null, subject || null,
      body || null, sanitizedHtml, finalStatus, duration_seconds || null,
      phone_number || null, from_address || null,
      JSON.stringify(to_addresses || []), JSON.stringify(cc_addresses || []),
      JSON.stringify(bcc_addresses || []), thread_id || null,
      req.user.id, scheduled_at || null, finalCompletedAt)

    if (Array.isArray(links)) {
      for (const link of links) {
        if (!link.record_id) continue
        db.prepare(`
          INSERT OR IGNORE INTO base_interaction_links (id, tenant_id, interaction_id, table_id, record_id)
          VALUES (?, ?, ?, ?, ?)
        `).run(newId('itl'), tenantId, id, link.table_id || null, link.record_id)
      }
    }
  })

  transaction()

  const created = db.prepare('SELECT * FROM base_interactions WHERE id = ?').get(id)
  broadcast(tenantId, { type: 'interaction:created', interaction: enrichInteraction(created), links: links || [] })
  res.status(201).json(enrichInteraction(created))
})

// ── PATCH /api/base/interactions/:id ─────────────────────────────────────────

router.patch('/:id', (req, res) => {
  const tenantId = req.user.tenant_id
  const itr = db.prepare(
    'SELECT * FROM base_interactions WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL'
  ).get(req.params.id, tenantId)
  if (!itr) return res.status(404).json({ error: 'Introuvable' })

  const fields = ['type','direction','subject','body','body_html','status','duration_seconds',
    'phone_number','from_address','to_addresses','cc_addresses','bcc_addresses',
    'thread_id','scheduled_at','completed_at']
  const sets = []
  const params = []
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      const val = f === 'body_html' ? sanitizeHtml(req.body[f]) : req.body[f]
      sets.push(`${f} = ?`)
      params.push(val)
    }
  }
  if (sets.length === 0) return res.json(enrichInteraction(itr))

  sets.push("updated_at = datetime('now')")
  params.push(req.params.id, tenantId)

  db.prepare(`UPDATE base_interactions SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`).run(...params)
  const updated = db.prepare('SELECT * FROM base_interactions WHERE id = ?').get(req.params.id)
  broadcast(tenantId, { type: 'interaction:updated', interaction: updated })
  res.json(enrichInteraction(updated))
})

// ── DELETE /api/base/interactions/:id ─────────────────────────────────────────

router.delete('/:id', (req, res) => {
  const tenantId = req.user.tenant_id
  const itr = db.prepare(
    'SELECT * FROM base_interactions WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL'
  ).get(req.params.id, tenantId)
  if (!itr) return res.status(404).json({ error: 'Introuvable' })
  db.prepare("UPDATE base_interactions SET deleted_at = datetime('now') WHERE id = ?").run(req.params.id)
  broadcast(tenantId, { type: 'interaction:deleted', id: req.params.id })
  res.json({ success: true })
})

// ── POST /api/base/interactions/:id/attachments ───────────────────────────────

router.post('/:id/attachments', upload.single('file'), (req, res) => {
  const tenantId = req.user.tenant_id
  if (!req.file) return res.status(400).json({ error: 'Fichier requis' })
  const itr = db.prepare(
    'SELECT id FROM base_interactions WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL'
  ).get(req.params.id, tenantId)
  if (!itr) return res.status(404).json({ error: 'Introuvable' })

  const count = db.prepare(
    'SELECT COUNT(*) as c FROM base_interaction_attachments WHERE interaction_id = ?'
  ).get(req.params.id).c
  if (count >= 25) return res.status(400).json({ error: 'Maximum 25 pièces jointes par interaction' })

  const url = `/api/interaction-files/${tenantId}/${req.params.id}/${req.file.filename}`
  const att = {
    id: newId('ita'),
    tenant_id: tenantId,
    interaction_id: req.params.id,
    name: req.file.originalname,
    url,
    mime_type: req.file.mimetype,
    size: req.file.size,
  }
  db.prepare(`
    INSERT INTO base_interaction_attachments (id, tenant_id, interaction_id, name, url, mime_type, size)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(att.id, att.tenant_id, att.interaction_id, att.name, att.url, att.mime_type, att.size)
  res.status(201).json(att)
})

// ── DELETE /api/base/interactions/:id/attachments/:attachmentId ───────────────

router.delete('/:id/attachments/:attachmentId', (req, res) => {
  const tenantId = req.user.tenant_id
  const att = db.prepare(
    'SELECT * FROM base_interaction_attachments WHERE id = ? AND interaction_id = ? AND tenant_id = ?'
  ).get(req.params.attachmentId, req.params.id, tenantId)
  if (!att) return res.status(404).json({ error: 'Introuvable' })
  db.prepare('DELETE FROM base_interaction_attachments WHERE id = ?').run(att.id)
  res.json({ success: true })
})

// ── POST /api/base/interactions/:id/links ─────────────────────────────────────

router.post('/:id/links', (req, res) => {
  const { table_id, record_id } = req.body
  const tenantId = req.user.tenant_id
  if (!record_id) return res.status(400).json({ error: 'record_id requis' })
  const id = newId('itl')
  try {
    db.prepare(`
      INSERT INTO base_interaction_links (id, tenant_id, interaction_id, table_id, record_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, tenantId, req.params.id, table_id || null, record_id)
    res.status(201).json({ id, interaction_id: req.params.id, table_id, record_id })
  } catch {
    res.status(409).json({ error: 'Ce lien existe déjà' })
  }
})

// ── DELETE /api/base/interactions/:id/links/:linkId ───────────────────────────

router.delete('/:id/links/:linkId', (req, res) => {
  db.prepare('DELETE FROM base_interaction_links WHERE id = ? AND interaction_id = ?')
    .run(req.params.linkId, req.params.id)
  res.json({ success: true })
})

// ── Connectors CRUD ───────────────────────────────────────────────────────────

router.get('/connectors/list', (req, res) => {
  const rows = db.prepare(
    'SELECT id, connector, enabled, config, sync_interval_minutes, last_sync_at, last_sync_status, last_sync_error, created_at FROM base_connector_configs WHERE tenant_id = ?'
  ).all(req.user.tenant_id)
  res.json(rows)
})

router.post('/connectors', (req, res) => {
  const { connector, config, credentials, sync_interval_minutes = 15 } = req.body
  if (!connector) return res.status(400).json({ error: 'connector requis' })
  const id = newId('connector')
  const encrypted = credentials ? encryptCredentials(JSON.stringify(credentials)) : null
  db.prepare(`
    INSERT INTO base_connector_configs (id, tenant_id, connector, config, credentials, sync_interval_minutes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, req.user.tenant_id, connector, JSON.stringify(config || {}), encrypted, sync_interval_minutes)
  res.status(201).json({ id, connector, enabled: 1, sync_interval_minutes })
})

router.patch('/connectors/:id', (req, res) => {
  const tenantId = req.user.tenant_id
  const row = db.prepare('SELECT * FROM base_connector_configs WHERE id = ? AND tenant_id = ?').get(req.params.id, tenantId)
  if (!row) return res.status(404).json({ error: 'Introuvable' })
  const updates = { ...req.body }
  if (updates.credentials) updates.credentials = encryptCredentials(JSON.stringify(updates.credentials))
  const sets = Object.keys(updates).filter(k => k !== 'id' && k !== 'tenant_id')
  if (sets.length === 0) return res.json(row)
  const params = sets.map(k => updates[k])
  params.push(req.params.id, tenantId)
  db.prepare(`UPDATE base_connector_configs SET ${sets.map(k => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ? AND tenant_id = ?`).run(...params)
  res.json({ success: true })
})

router.delete('/connectors/:id', (req, res) => {
  db.prepare('DELETE FROM base_connector_configs WHERE id = ? AND tenant_id = ?').run(req.params.id, req.user.tenant_id)
  res.json({ success: true })
})

router.post('/connectors/:id/test', async (req, res) => {
  const row = db.prepare('SELECT * FROM base_connector_configs WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user.tenant_id)
  if (!row) return res.status(404).json({ error: 'Introuvable' })
  const connector = connectors[row.connector]
  if (!connector) return res.status(400).json({ error: 'Connecteur inconnu' })
  try {
    const creds = (() => { try { return JSON.parse(decryptCredentials(row.credentials) || '{}') } catch { return {} } })()
    const cfg = (() => { try { return JSON.parse(row.config || '{}') } catch { return {} } })()
    const result = await connector.testConnection(cfg, creds)
    res.json(result)
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

export default router
