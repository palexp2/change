import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import db from '../db/database.js'
import { requireAuth, requireAdmin } from '../middleware/auth.js'

const router = Router()

const ALLOWED_TABLES = new Set([
  'companies', 'contacts', 'projects', 'products',
  'orders', 'tickets', 'purchases', 'serial_numbers', 'interactions'
])

function validateTable(req, res) {
  if (!ALLOWED_TABLES.has(req.params.table)) {
    res.status(400).json({ error: 'Table inconnue' })
    return false
  }
  return true
}

function parsePill(p) {
  return {
    ...p,
    filters: JSON.parse(p.filters || '[]'),
    visible_columns: JSON.parse(p.visible_columns || '[]'),
    sort: JSON.parse(p.sort || '[]'),
  }
}

// GET /api/views/:table
router.get('/:table', requireAuth, (req, res) => {
  if (!validateTable(req, res)) return
  const { tenant_id } = req.user
  const { table } = req.params

  const config = db.prepare(
    'SELECT visible_columns, default_sort FROM table_view_configs WHERE tenant_id=? AND table_name=?'
  ).get(tenant_id, table)

  const pills = db.prepare(
    'SELECT id, label, color, filters, visible_columns, sort, group_by, sort_order FROM table_view_pills WHERE tenant_id=? AND table_name=? ORDER BY sort_order, created_at'
  ).all(tenant_id, table)

  res.json({
    config: config
      ? { visible_columns: JSON.parse(config.visible_columns), default_sort: JSON.parse(config.default_sort) }
      : { visible_columns: [], default_sort: [] },
    pills: pills.map(parsePill)
  })
})

// PUT /api/views/:table
router.put('/:table', requireAdmin, (req, res) => {
  if (!validateTable(req, res)) return
  const { tenant_id } = req.user
  const { table } = req.params
  const { visible_columns, default_sort } = req.body

  if (!Array.isArray(visible_columns) || !Array.isArray(default_sort)) {
    return res.status(400).json({ error: 'visible_columns et default_sort doivent être des tableaux' })
  }

  const existing = db.prepare(
    'SELECT id FROM table_view_configs WHERE tenant_id=? AND table_name=?'
  ).get(tenant_id, table)

  if (existing) {
    db.prepare(
      "UPDATE table_view_configs SET visible_columns=?, default_sort=?, updated_at=datetime('now') WHERE tenant_id=? AND table_name=?"
    ).run(JSON.stringify(visible_columns), JSON.stringify(default_sort), tenant_id, table)
  } else {
    db.prepare(
      'INSERT INTO table_view_configs (id, tenant_id, table_name, visible_columns, default_sort) VALUES (?,?,?,?,?)'
    ).run(uuidv4(), tenant_id, table, JSON.stringify(visible_columns), JSON.stringify(default_sort))
  }

  res.json({ ok: true })
})

// POST /api/views/:table/pills
router.post('/:table/pills', requireAdmin, (req, res) => {
  if (!validateTable(req, res)) return
  const { tenant_id } = req.user
  const { table } = req.params
  const { label, color = 'gray', filters = [], sort_order = 0, visible_columns = [], sort = [], group_by = null } = req.body

  if (!label) return res.status(400).json({ error: 'label requis' })
  if (!Array.isArray(filters)) return res.status(400).json({ error: 'filters doit être un tableau' })

  const id = uuidv4()
  db.prepare(
    'INSERT INTO table_view_pills (id, tenant_id, table_name, label, color, filters, visible_columns, sort, group_by, sort_order) VALUES (?,?,?,?,?,?,?,?,?,?)'
  ).run(id, tenant_id, table, label, color, JSON.stringify(filters), JSON.stringify(visible_columns), JSON.stringify(sort), group_by, sort_order)

  const pill = db.prepare('SELECT * FROM table_view_pills WHERE id=?').get(id)
  res.status(201).json(parsePill(pill))
})

// PATCH /api/views/:table/pills/reorder
router.patch('/:table/pills/reorder', requireAdmin, (req, res) => {
  if (!validateTable(req, res)) return
  const { tenant_id } = req.user
  const { table } = req.params
  const order = req.body
  if (!Array.isArray(order)) return res.status(400).json({ error: 'Un tableau est requis' })

  const update = db.prepare(
    'UPDATE table_view_pills SET sort_order=? WHERE id=? AND tenant_id=? AND table_name=?'
  )
  const updateAll = db.transaction(items => {
    for (const { id, sort_order } of items) update.run(sort_order, id, tenant_id, table)
  })
  updateAll(order)

  res.json({ ok: true })
})

// PUT /api/views/:table/pills/:id
router.put('/:table/pills/:id', requireAdmin, (req, res) => {
  if (!validateTable(req, res)) return
  const { tenant_id } = req.user
  const { table, id } = req.params

  const pill = db.prepare(
    'SELECT id FROM table_view_pills WHERE id=? AND tenant_id=? AND table_name=?'
  ).get(id, tenant_id, table)
  if (!pill) return res.status(404).json({ error: 'Vue introuvable' })

  const body = req.body
  const updates = []
  const values = []

  if (body.label !== undefined)           { updates.push('label = ?');           values.push(body.label) }
  if (body.color !== undefined)           { updates.push('color = ?');           values.push(body.color) }
  if (body.filters !== undefined)         { updates.push('filters = ?');         values.push(JSON.stringify(body.filters)) }
  if (body.visible_columns !== undefined) { updates.push('visible_columns = ?'); values.push(JSON.stringify(body.visible_columns)) }
  if (body.sort !== undefined)            { updates.push('sort = ?');            values.push(JSON.stringify(body.sort)) }
  if ('group_by' in body)                 { updates.push('group_by = ?');        values.push(body.group_by) }
  if (body.sort_order !== undefined)      { updates.push('sort_order = ?');      values.push(body.sort_order) }

  if (updates.length === 0) return res.status(400).json({ error: 'Aucun champ à modifier' })

  db.prepare(`UPDATE table_view_pills SET ${updates.join(', ')} WHERE id=?`).run(...values, id)

  const updated = db.prepare('SELECT * FROM table_view_pills WHERE id=?').get(id)
  res.json(parsePill(updated))
})

// DELETE /api/views/:table/pills/:id
router.delete('/:table/pills/:id', requireAdmin, (req, res) => {
  if (!validateTable(req, res)) return
  const { tenant_id } = req.user
  const { table, id } = req.params

  const pill = db.prepare(
    'SELECT id FROM table_view_pills WHERE id=? AND tenant_id=? AND table_name=?'
  ).get(id, tenant_id, table)
  if (!pill) return res.status(404).json({ error: 'Vue introuvable' })

  db.prepare('DELETE FROM table_view_pills WHERE id=?').run(id)
  res.json({ ok: true })
})

export default router
