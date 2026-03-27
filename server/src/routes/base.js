import { Router } from 'express'
import { existsSync, mkdirSync, unlinkSync } from 'fs'
import { join, extname } from 'path'
import multer from 'multer'
import { v4 as uuid } from 'uuid'
import { requireAuth } from '../middleware/auth.js'
import db from '../db/database.js'
import * as svc from '../services/baseService.js'
import { importRecords } from '../services/importService.js'
import { broadcast } from '../services/realtime.js'
import { triggerWebhooks } from '../services/webhookService.js'

const router = Router()
router.use(requireAuth)

// ── Attachment upload setup ───────────────────────────────────────────────────

const uploadsBase = join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'attachments')
if (!existsSync(uploadsBase)) mkdirSync(uploadsBase, { recursive: true })

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = join(uploadsBase, req.user.tenant_id, req.params.id)
    mkdirSync(dir, { recursive: true })
    cb(null, dir)
  },
  filename: (req, file, cb) => cb(null, `${uuid()}${extname(file.originalname)}`),
})
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } })

// ── Error helper ─────────────────────────────────────────────────────────────

function handle(res, fn) {
  try {
    const result = fn()
    if (result === null || result === undefined) return res.status(404).json({ error: 'Introuvable' })
    return res.json(result)
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || 'Erreur serveur' })
  }
}

// ── Tables ────────────────────────────────────────────────────────────────────

router.get('/tables', (req, res) => {
  try {
    const tables = svc.getTables(req.user.tenant_id)
    res.json({ tables })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/tables', (req, res) => {
  const { name, icon, color, description } = req.body
  if (!name?.trim()) return res.status(400).json({ error: 'Le nom est requis' })
  try {
    const result = svc.createTable(req.user.tenant_id, { name: name.trim(), icon, color, description })
    res.status(201).json(result)
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message })
  }
})

router.patch('/tables/:id', (req, res) => {
  handle(res, () => svc.updateTable(req.user.tenant_id, req.params.id, req.body))
})

router.delete('/tables/:id', (req, res) => {
  handle(res, () => svc.deleteTable(req.user.tenant_id, req.params.id))
})

router.post('/tables/:id/restore', (req, res) => {
  handle(res, () => svc.restoreTable(req.user.tenant_id, req.params.id))
})

// ── Fields ────────────────────────────────────────────────────────────────────

router.get('/tables/:id/fields', (req, res) => {
  try {
    const fields = svc.getFields(req.user.tenant_id, req.params.id)
    if (!fields) return res.status(404).json({ error: 'Introuvable' })
    res.json({ fields })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/tables/:id/fields', (req, res) => {
  const { name, key, type, options, required, default_value, width } = req.body
  if (!name?.trim()) return res.status(400).json({ error: 'Le nom est requis' })
  try {
    const result = svc.createField(req.user.tenant_id, req.params.id, { name: name.trim(), key, type, options, required, default_value, width })
    if (!result) return res.status(404).json({ error: 'Introuvable' })
    res.status(201).json(result)
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message })
  }
})

router.patch('/fields/:id', (req, res) => {
  try {
    const result = svc.updateField(req.user.tenant_id, req.params.id, req.body)
    if (!result) return res.status(404).json({ error: 'Introuvable' })
    res.json(result)
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message })
  }
})

router.delete('/fields/:id', (req, res) => {
  try {
    const result = svc.deleteField(req.user.tenant_id, req.params.id)
    if (!result) return res.status(404).json({ error: 'Introuvable' })
    res.json(result)
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message })
  }
})

router.post('/fields/:id/restore', (req, res) => {
  handle(res, () => svc.restoreField(req.user.tenant_id, req.params.id))
})

router.patch('/tables/:id/fields/reorder', (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'Tableau attendu' })
  handle(res, () => svc.reorderFields(req.user.tenant_id, req.params.id, req.body))
})

// ── Records ───────────────────────────────────────────────────────────────────

router.get('/tables/:id/records', (req, res) => {
  const { search, filters, sorts, limit, page, view_id, group_by, group_summaries } = req.query
  handle(res, () => svc.getRecords(req.user.tenant_id, req.params.id, { search, filters, sorts, limit, page, view_id, group_by, group_summaries }))
})

router.get('/records/:id', (req, res) => {
  handle(res, () => svc.getRecord(req.user.tenant_id, req.params.id))
})

router.post('/tables/:id/records', (req, res) => {
  const { data } = req.body
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'data (objet) est requis' })
  try {
    const result = svc.createRecord(req.user.tenant_id, req.params.id, req.user.id, data)
    if (!result) return res.status(404).json({ error: 'Introuvable' })
    res.status(201).json(result)
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message })
  }
})

router.patch('/records/:id', (req, res) => {
  const { data } = req.body
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'data (objet) est requis' })
  handle(res, () => svc.updateRecord(req.user.tenant_id, req.params.id, req.user.id, data))
})

router.delete('/records/:id', (req, res) => {
  handle(res, () => svc.deleteRecord(req.user.tenant_id, req.params.id, req.user.id))
})

router.post('/records/:id/restore', (req, res) => {
  handle(res, () => svc.restoreRecord(req.user.tenant_id, req.params.id, req.user.id))
})

router.post('/records/:id/duplicate', (req, res) => {
  try {
    const result = svc.duplicateRecord(req.user.tenant_id, req.params.id, req.user.id)
    if (!result) return res.status(404).json({ error: 'Introuvable' })
    res.status(201).json(result)
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message })
  }
})

router.get('/records/:id/interactions', (req, res) => {
  const { type, limit = 20, page = 1 } = req.query
  const recordId = req.params.id
  const tenantId = req.user.tenant_id

  let query = `
    SELECT i.*, u.name as user_name
    FROM base_interactions i
    JOIN base_interaction_links il ON il.interaction_id = i.id
    LEFT JOIN users u ON i.user_id = u.id
    WHERE il.record_id = ? AND i.tenant_id = ? AND i.deleted_at IS NULL
  `
  const params = [recordId, tenantId]
  if (type) { query += ' AND i.type = ?'; params.push(type) }

  const countQuery = query.replace('SELECT i.*, u.name as user_name', 'SELECT COUNT(DISTINCT i.id) as total')
  const total = db.prepare(countQuery).get(...params).total

  query += ' GROUP BY i.id ORDER BY COALESCE(i.completed_at, i.created_at) DESC LIMIT ? OFFSET ?'
  params.push(Number(limit), (Number(page) - 1) * Number(limit))

  const interactions = db.prepare(query).all(...params)
  for (const itr of interactions) {
    itr.links = db.prepare(`
      SELECT il.*, bt.name as table_name, bt.icon as table_icon, bt.slug as table_slug,
             json_extract(br.data, '$.' || (SELECT key FROM base_fields WHERE table_id = bt.id AND is_primary = 1 LIMIT 1)) as primary_value
      FROM base_interaction_links il
      LEFT JOIN base_tables bt ON il.table_id = bt.id
      LEFT JOIN base_records br ON il.record_id = br.id
      WHERE il.interaction_id = ?
    `).all(itr.id)
    itr.attachments = db.prepare(
      'SELECT * FROM base_interaction_attachments WHERE interaction_id = ?'
    ).all(itr.id)
  }

  const typeCounts = db.prepare(`
    SELECT i.type, COUNT(DISTINCT i.id) as count
    FROM base_interactions i
    JOIN base_interaction_links il ON il.interaction_id = i.id
    WHERE il.record_id = ? AND i.tenant_id = ? AND i.deleted_at IS NULL
    GROUP BY i.type
  `).all(recordId, tenantId)

  res.json({ data: interactions, total, type_counts: typeCounts, page: Number(page), limit: Number(limit) })
})

router.patch('/tables/:id/records/reorder', (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'Tableau attendu' })
  handle(res, () => svc.reorderRecords(req.user.tenant_id, req.params.id, req.body))
})

router.get('/records/:id/history', (req, res) => {
  handle(res, () => svc.getRecordHistory(req.user.tenant_id, req.params.id))
})

// ── Attachments ───────────────────────────────────────────────────────────────

router.post('/records/:id/attachments', upload.single('file'), (req, res) => {
  const { field_key } = req.body
  if (!field_key || !req.file) return res.status(400).json({ error: 'field_key et file sont requis' })

  try {
    const record = db.prepare(`
      SELECT r.* FROM base_records r JOIN base_tables t ON r.table_id = t.id
      WHERE r.id = ? AND t.tenant_id = ?
    `).get(req.params.id, req.user.tenant_id)
    if (!record) return res.status(404).json({ error: 'Introuvable' })

    const data = JSON.parse(record.data || '{}')
    const existing = Array.isArray(data[field_key]) ? data[field_key] : []
    if (existing.length >= 10) return res.status(400).json({ error: '10 fichiers maximum par champ' })

    const fileUrl = `/api/attachments/${req.user.tenant_id}/${req.params.id}/${req.file.filename}`
    existing.push({ name: req.file.originalname, url: fileUrl, size: req.file.size, mime: req.file.mimetype })
    data[field_key] = existing

    db.prepare("UPDATE base_records SET data = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(data), req.params.id)

    res.json({ ...record, data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.delete('/records/:id/attachments/:filename', (req, res) => {
  const { field_key } = req.body
  if (!field_key) return res.status(400).json({ error: 'field_key est requis' })

  try {
    const record = db.prepare(`
      SELECT r.* FROM base_records r JOIN base_tables t ON r.table_id = t.id
      WHERE r.id = ? AND t.tenant_id = ?
    `).get(req.params.id, req.user.tenant_id)
    if (!record) return res.status(404).json({ error: 'Introuvable' })

    const data = JSON.parse(record.data || '{}')
    const existing = Array.isArray(data[field_key]) ? data[field_key] : []
    const filename = req.params.filename
    data[field_key] = existing.filter(f => !f.url.endsWith(`/${filename}`))

    // Delete from disk
    const filePath = join(uploadsBase, req.user.tenant_id, req.params.id, filename)
    if (existsSync(filePath)) unlinkSync(filePath)

    db.prepare("UPDATE base_records SET data = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(data), req.params.id)

    res.json({ ...record, data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Views ─────────────────────────────────────────────────────────────────────

router.get('/tables/:id/views', (req, res) => {
  try {
    const views = svc.getViews(req.user.tenant_id, req.params.id)
    if (!views) return res.status(404).json({ error: 'Introuvable' })
    res.json({ views })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/tables/:id/views', (req, res) => {
  const { name, ...rest } = req.body
  if (!name?.trim()) return res.status(400).json({ error: 'Le nom est requis' })
  try {
    const result = svc.createView(req.user.tenant_id, req.params.id, { name: name.trim(), ...rest })
    if (!result) return res.status(404).json({ error: 'Introuvable' })
    res.status(201).json(result)
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message })
  }
})

router.patch('/views/:id', (req, res) => {
  handle(res, () => svc.updateView(req.user.tenant_id, req.params.id, req.body))
})

router.delete('/views/:id', (req, res) => {
  try {
    const result = svc.deleteView(req.user.tenant_id, req.params.id)
    if (!result) return res.status(404).json({ error: 'Introuvable' })
    res.json(result)
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message })
  }
})

router.post('/views/:id/duplicate', (req, res) => {
  try {
    const result = svc.duplicateView(req.user.tenant_id, req.params.id)
    if (!result) return res.status(404).json({ error: 'Introuvable' })
    res.status(201).json(result)
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message })
  }
})

router.post('/views/:id/restore', (req, res) => {
  handle(res, () => svc.restoreView(req.user.tenant_id, req.params.id))
})

// ── Trash ─────────────────────────────────────────────────────────────────────

router.get('/trash', (req, res) => {
  handle(res, () => svc.getTrash(req.user.tenant_id))
})

router.delete('/trash', (req, res) => {
  handle(res, () => svc.purgeTrash(req.user.tenant_id))
})

// ── Bulk operations ───────────────────────────────────────────────────────────

router.patch('/tables/:id/records/bulk', (req, res) => {
  const { record_ids, data } = req.body
  if (!Array.isArray(record_ids) || !data) return res.status(400).json({ error: 'record_ids et data sont requis' })
  try {
    const result = svc.bulkUpdateRecords(req.user.tenant_id, req.params.id, record_ids, data, req.user.id)
    if (!result) return res.status(404).json({ error: 'Introuvable' })
    res.json(result)
    broadcast(req.user.tenant_id, { type: 'records:bulk_updated', tableId: req.params.id, record_ids, data })
    triggerWebhooks(req.user.tenant_id, req.params.id, 'record:updated', { record_ids, data })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message })
  }
})

router.delete('/tables/:id/records/bulk', (req, res) => {
  const { record_ids } = req.body
  if (!Array.isArray(record_ids)) return res.status(400).json({ error: 'record_ids (tableau) est requis' })
  try {
    const result = svc.bulkDeleteRecords(req.user.tenant_id, req.params.id, record_ids, req.user.id)
    if (!result) return res.status(404).json({ error: 'Introuvable' })
    res.json(result)
    broadcast(req.user.tenant_id, { type: 'records:bulk_deleted', tableId: req.params.id, record_ids })
    triggerWebhooks(req.user.tenant_id, req.params.id, 'record:deleted', { record_ids })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message })
  }
})

router.post('/tables/:id/records/bulk', (req, res) => {
  const { records } = req.body
  if (!Array.isArray(records)) return res.status(400).json({ error: 'records (tableau) est requis' })
  try {
    const result = svc.bulkCreateRecords(req.user.tenant_id, req.params.id, records, req.user.id)
    if (!result) return res.status(404).json({ error: 'Introuvable' })
    res.status(201).json(result)
    broadcast(req.user.tenant_id, { type: 'records:bulk_created', tableId: req.params.id, count: result.created })
    triggerWebhooks(req.user.tenant_id, req.params.id, 'record:created', { records: result.records })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message })
  }
})

// ── Import ────────────────────────────────────────────────────────────────────

const importStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'imports')
    mkdirSync(dir, { recursive: true })
    cb(null, dir)
  },
  filename: (req, file, cb) => cb(null, `${uuid()}${extname(file.originalname)}`)
})
const importUpload = multer({ storage: importStorage, limits: { fileSize: 50 * 1024 * 1024 } })

router.post('/tables/:id/import', importUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Fichier requis' })
  const { mapping, mode } = req.body
  try {
    const result = await importRecords(
      req.user.tenant_id, req.params.id, req.file.path,
      mapping, mode || 'append', req.user.id
    )
    res.json(result)
    broadcast(req.user.tenant_id, { type: 'records:imported', tableId: req.params.id, count: result.imported })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message })
  }
})

// ── Export ────────────────────────────────────────────────────────────────────

router.get('/tables/:id/export', async (req, res) => {
  const { format, view_id } = req.query
  if (!['csv', 'xlsx', 'json'].includes(format)) return res.status(400).json({ error: 'format doit être csv, xlsx ou json' })

  const tid = req.user.tenant_id
  const tableId = req.params.id

  const table = db.prepare('SELECT * FROM base_tables WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL').get(tableId, tid)
  if (!table) return res.status(404).json({ error: 'Introuvable' })

  // Load fields
  let fields = db.prepare('SELECT * FROM base_fields WHERE table_id = ? AND deleted_at IS NULL ORDER BY is_primary DESC, sort_order ASC').all(tableId)

  // Load view config
  let filterConfig = null, sortConfig = [], visibleFieldIds = null
  if (view_id) {
    const view = db.prepare('SELECT * FROM base_views WHERE id = ? AND deleted_at IS NULL').get(view_id)
    if (view) {
      let cfg = {}
      try { cfg = JSON.parse(view.config) } catch {}
      filterConfig = cfg.filters || null
      sortConfig = cfg.sorts || []
      visibleFieldIds = cfg.visible_fields || null
    }
  }

  // Filter fields by view visible_fields
  if (visibleFieldIds) {
    fields = fields.filter(f => visibleFieldIds.includes(f.id))
  }

  // Build SQL
  const { buildFilterSQL } = await import('../services/filterEngine.js')
  const where = ['r.tenant_id = ?', 'r.table_id = ?', 'r.deleted_at IS NULL']
  const params = [tid, tableId]

  if (filterConfig) {
    const { sql, params: fp } = buildFilterSQL(filterConfig)
    if (sql && sql !== '1=1') { where.push(`(${sql})`); params.push(...fp) }
  }

  let orderBy = 'r.sort_order ASC, r.created_at ASC'
  if (sortConfig.length) {
    const sc = sortConfig.filter(s => /^[a-zA-Z0-9_]+$/.test(s.field_key))
      .map(s => `json_extract(r.data, '$.${s.field_key}') ${s.direction === 'desc' ? 'DESC' : 'ASC'}`)
    if (sc.length) orderBy = sc.join(', ')
  }

  const rows = db.prepare(`SELECT * FROM base_records r WHERE ${where.join(' AND ')} ORDER BY ${orderBy} LIMIT 10000`)
    .all(...params)

  const { enrichRecords } = await import('../services/computedFields.js')
  const parsedFields = fields.map(f => { try { return { ...f, options: JSON.parse(f.options || '{}') } } catch { return { ...f, options: {} } } })
  const parsed = rows.map(r => { try { return { ...r, data: JSON.parse(r.data || '{}') } } catch { return { ...r, data: {} } } })
  const enriched = enrichRecords(db, parsed, parsedFields)

  const dateStr = new Date().toISOString().split('T')[0]
  const slug = table.slug || table.name.toLowerCase().replace(/\s+/g, '-')
  const filename = `${slug}_${dateStr}`

  if (format === 'json') {
    const out = enriched.map(r => {
      const obj = {}
      for (const f of fields) obj[f.name] = r.data[f.key] ?? null
      return obj
    })
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.json"`)
    return res.json(out)
  }

  if (format === 'csv') {
    const escape = v => {
      if (v === null || v === undefined) return ''
      const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s
    }
    const header = fields.map(f => escape(f.name)).join(',')
    const dataLines = enriched.map(r => fields.map(f => escape(r.data[f.key])).join(','))
    const csv = [header, ...dataLines].join('\n')
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`)
    return res.send(csv)
  }

  if (format === 'xlsx') {
    const { utils, write } = await import('xlsx')
    const wsData = [
      fields.map(f => f.name),
      ...enriched.map(r => fields.map(f => {
        const v = r.data[f.key]
        return v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : v)
      }))
    ]
    const ws = utils.aoa_to_sheet(wsData)
    const wb = utils.book_new()
    utils.book_append_sheet(wb, ws, table.name.slice(0, 31))
    const buf = write(wb, { type: 'buffer', bookType: 'xlsx' })
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`)
    return res.send(buf)
  }
})

// ── Global search ─────────────────────────────────────────────────────────────

router.get('/search', (req, res) => {
  const { q, limit = 20 } = req.query
  if (!q || q.trim().length < 2) return res.status(400).json({ error: 'q doit contenir au moins 2 caractères' })
  const lim = Math.min(parseInt(limit) || 20, 50)
  const tid = req.user.tenant_id
  const query = q.trim()

  const results = db.prepare(`
    SELECT r.id as record_id, r.table_id,
      t.name as table_name, t.icon as table_icon, t.slug as table_slug,
      json_extract(r.data, '$.' || f.key) as primary_value,
      f.key as match_field
    FROM base_records r
    JOIN base_tables t ON r.table_id = t.id
    JOIN base_fields f ON f.table_id = t.id AND f.is_primary = 1 AND f.deleted_at IS NULL
    WHERE r.tenant_id = ? AND r.deleted_at IS NULL AND t.deleted_at IS NULL
      AND json_extract(r.data, '$.' || f.key) LIKE ?
    ORDER BY
      CASE WHEN json_extract(r.data, '$.' || f.key) = ? THEN 0 ELSE 1 END,
      json_extract(r.data, '$.' || f.key) ASC
    LIMIT ?
  `).all(tid, `%${query}%`, query, lim)

  res.json({ results })
})

export default router
