import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import db from '../db/database.js'
import { newId } from '../utils/ids.js'
import { computeMetricData, computeChartData, computeListData } from '../services/interfaceDataService.js'

const router = Router()
router.use(requireAuth)

const ALLOWED_BLOCK_TYPES = ['metric', 'chart', 'list', 'detail', 'form', 'button', 'text', 'filter', 'interaction_timeline']

const DEFAULT_SIZES = {
  metric:                { w: 3, h: 2 },
  chart:                 { w: 6, h: 4 },
  list:                  { w: 6, h: 5 },
  detail:                { w: 6, h: 5 },
  form:                  { w: 4, h: 5 },
  button:                { w: 2, h: 1 },
  text:                  { w: 6, h: 2 },
  filter:                { w: 3, h: 1 },
  interaction_timeline:  { w: 6, h: 5 },
}

// ── Helper: map DB block row to API shape ─────────────────────────────────────

function mapBlock(b) {
  return {
    ...b,
    grid_x: b.x,
    grid_y: b.y,
    grid_w: b.w,
    grid_h: b.h,
  }
}

// ── Interfaces ─────────────────────────────────────────────────────────────

// GET /api/interfaces
router.get('/', (req, res) => {
  const tenantId = req.user.tenant_id
  const ifaces = db.prepare(`
    SELECT i.*, (
      SELECT COUNT(*) FROM base_interface_pages p WHERE p.interface_id = i.id
    ) as page_count
    FROM base_interfaces i
    WHERE i.tenant_id = ? AND i.deleted_at IS NULL
    ORDER BY i.sort_order ASC, i.created_at ASC
  `).all(tenantId)

  const filtered = ifaces.filter(i => {
    const roles = JSON.parse(i.role_access || '[]')
    return roles.length === 0 || roles.includes(req.user.role)
  })

  res.json(filtered)
})

// GET /api/interfaces/:id  (single, needed by InterfaceView)
router.get('/:id', (req, res) => {
  const tenantId = req.user.tenant_id
  const iface = db.prepare(`
    SELECT i.*, (SELECT COUNT(*) FROM base_interface_pages p WHERE p.interface_id = i.id) as page_count
    FROM base_interfaces i WHERE i.id = ? AND i.tenant_id = ?
  `).get(req.params.id, tenantId)
  if (!iface) return res.status(404).json({ error: 'Interface introuvable' })

  const roles = JSON.parse(iface.role_access || '[]')
  if (roles.length > 0 && !roles.includes(req.user.role)) {
    return res.status(403).json({ error: 'Accès refusé' })
  }

  res.json(iface)
})

// POST /api/interfaces
router.post('/', (req, res) => {
  const tenantId = req.user.tenant_id
  const { name, icon, color, role_access } = req.body
  if (!name) return res.status(400).json({ error: 'name requis' })

  const id = newId('iface')
  const maxOrder = db.prepare(
    'SELECT COALESCE(MAX(sort_order), -1) as m FROM base_interfaces WHERE tenant_id = ?'
  ).get(tenantId)?.m ?? -1

  db.prepare(`
    INSERT INTO base_interfaces (id, tenant_id, name, icon, color, role_access, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, tenantId, name, icon || null, color || 'indigo', JSON.stringify(role_access || []), maxOrder + 1)

  // Create first page automatically
  const pageId = newId('page')
  db.prepare(`
    INSERT INTO base_interface_pages (id, interface_id, name, sort_order)
    VALUES (?, ?, ?, ?)
  `).run(pageId, id, 'Page 1', 0)

  const iface = db.prepare('SELECT * FROM base_interfaces WHERE id = ?').get(id)
  const page = db.prepare('SELECT * FROM base_interface_pages WHERE id = ?').get(pageId)
  res.status(201).json({ ...iface, page_count: 1, first_page: page })
})

// PATCH /api/interfaces/:id
router.patch('/:id', (req, res) => {
  const tenantId = req.user.tenant_id
  const iface = db.prepare('SELECT * FROM base_interfaces WHERE id = ? AND tenant_id = ?').get(req.params.id, tenantId)
  if (!iface) return res.status(404).json({ error: 'Interface introuvable' })

  const { name, icon, color, role_access, sort_order } = req.body
  const fields = []
  const params = []

  if (name !== undefined) { fields.push('name = ?'); params.push(name) }
  if (icon !== undefined) { fields.push('icon = ?'); params.push(icon) }
  if (color !== undefined) { fields.push('color = ?'); params.push(color) }
  if (role_access !== undefined) { fields.push('role_access = ?'); params.push(JSON.stringify(role_access)) }
  if (sort_order !== undefined) { fields.push('sort_order = ?'); params.push(sort_order) }

  if (fields.length === 0) return res.json(iface)

  fields.push('updated_at = datetime(\'now\')')
  params.push(req.params.id)
  db.prepare(`UPDATE base_interfaces SET ${fields.join(', ')} WHERE id = ?`).run(...params)

  res.json(db.prepare('SELECT * FROM base_interfaces WHERE id = ?').get(req.params.id))
})

// DELETE /api/interfaces/:id
router.delete('/:id', (req, res) => {
  const tenantId = req.user.tenant_id
  const iface = db.prepare('SELECT * FROM base_interfaces WHERE id = ? AND tenant_id = ?').get(req.params.id, tenantId)
  if (!iface) return res.status(404).json({ error: 'Interface introuvable' })

  db.prepare('UPDATE base_interfaces SET deleted_at = datetime(\'now\') WHERE id = ?').run(req.params.id)
  res.json({ success: true })
})

// POST /api/interfaces/:id/restore
router.post('/:id/restore', (req, res) => {
  const tenantId = req.user.tenant_id
  const iface = db.prepare('SELECT * FROM base_interfaces WHERE id = ? AND tenant_id = ?').get(req.params.id, tenantId)
  if (!iface) return res.status(404).json({ error: 'Interface introuvable' })

  db.prepare('UPDATE base_interfaces SET deleted_at = NULL WHERE id = ?').run(req.params.id)
  res.json(db.prepare('SELECT * FROM base_interfaces WHERE id = ?').get(req.params.id))
})

// ── Pages ──────────────────────────────────────────────────────────────────

// GET /api/interfaces/:id/pages
router.get('/:id/pages', (req, res) => {
  const pages = db.prepare(`
    SELECT p.* FROM base_interface_pages p
    JOIN base_interfaces i ON i.id = p.interface_id
    WHERE p.interface_id = ? AND i.tenant_id = ?
    ORDER BY p.sort_order ASC
  `).all(req.params.id, req.user.tenant_id)
  res.json(pages)
})

// POST /api/interfaces/:id/pages
router.post('/:id/pages', (req, res) => {
  const tenantId = req.user.tenant_id
  const iface = db.prepare('SELECT * FROM base_interfaces WHERE id = ? AND tenant_id = ?').get(req.params.id, tenantId)
  if (!iface) return res.status(404).json({ error: 'Interface introuvable' })

  const { name } = req.body
  if (!name) return res.status(400).json({ error: 'name requis' })

  const maxOrder = db.prepare(
    'SELECT COALESCE(MAX(sort_order), -1) as m FROM base_interface_pages WHERE interface_id = ?'
  ).get(req.params.id)?.m ?? -1

  const id = newId('page')
  db.prepare('INSERT INTO base_interface_pages (id, interface_id, name, sort_order) VALUES (?, ?, ?, ?)').run(
    id, req.params.id, name, maxOrder + 1
  )
  res.status(201).json(db.prepare('SELECT * FROM base_interface_pages WHERE id = ?').get(id))
})

// PATCH /api/interface-pages/:id  (note: no iface prefix in path)
router.patch('/pages/:pageId', (req, res) => {
  const page = db.prepare('SELECT * FROM base_interface_pages WHERE id = ?').get(req.params.pageId)
  if (!page) return res.status(404).json({ error: 'Page introuvable' })

  // Verify tenant access
  const iface = db.prepare('SELECT * FROM base_interfaces WHERE id = ? AND tenant_id = ?').get(page.interface_id, req.user.tenant_id)
  if (!iface) return res.status(403).json({ error: 'Accès refusé' })

  const { name, sort_order } = req.body
  const fields = []
  const params = []
  if (name !== undefined) { fields.push('name = ?'); params.push(name) }
  if (sort_order !== undefined) { fields.push('sort_order = ?'); params.push(sort_order) }
  if (fields.length === 0) return res.json(page)

  params.push(req.params.pageId)
  db.prepare(`UPDATE base_interface_pages SET ${fields.join(', ')} WHERE id = ?`).run(...params)
  res.json(db.prepare('SELECT * FROM base_interface_pages WHERE id = ?').get(req.params.pageId))
})

// DELETE /api/interface-pages/:id
router.delete('/pages/:pageId', (req, res) => {
  const page = db.prepare('SELECT * FROM base_interface_pages WHERE id = ?').get(req.params.pageId)
  if (!page) return res.status(404).json({ error: 'Page introuvable' })

  const iface = db.prepare('SELECT * FROM base_interfaces WHERE id = ? AND tenant_id = ?').get(page.interface_id, req.user.tenant_id)
  if (!iface) return res.status(403).json({ error: 'Accès refusé' })

  db.prepare('DELETE FROM base_interface_pages WHERE id = ?').run(req.params.pageId)
  res.json({ success: true })
})

// PATCH /api/interfaces/:id/pages/reorder
router.patch('/:id/pages/reorder', (req, res) => {
  const tenantId = req.user.tenant_id
  const iface = db.prepare('SELECT * FROM base_interfaces WHERE id = ? AND tenant_id = ?').get(req.params.id, tenantId)
  if (!iface) return res.status(404).json({ error: 'Interface introuvable' })

  const updates = req.body // [{ id, sort_order }]
  const update = db.prepare('UPDATE base_interface_pages SET sort_order = ? WHERE id = ? AND interface_id = ?')
  const run = db.transaction(() => updates.forEach(u => update.run(u.sort_order, u.id, req.params.id)))
  run()
  res.json({ success: true })
})

// ── Blocks ─────────────────────────────────────────────────────────────────

// GET /api/interface-pages/:id/blocks  → mounted at /pages/:pageId/blocks
router.get('/pages/:pageId/blocks', (req, res) => {
  const page = db.prepare('SELECT * FROM base_interface_pages WHERE id = ?').get(req.params.pageId)
  if (!page) return res.status(404).json({ error: 'Page introuvable' })

  const iface = db.prepare('SELECT * FROM base_interfaces WHERE id = ? AND tenant_id = ?').get(page.interface_id, req.user.tenant_id)
  if (!iface) return res.status(403).json({ error: 'Accès refusé' })

  const blocks = db.prepare('SELECT * FROM base_interface_blocks WHERE page_id = ? ORDER BY y ASC, x ASC').all(req.params.pageId)
  res.json(blocks.map(mapBlock))
})

// POST /api/interface-pages/:id/blocks
router.post('/pages/:pageId/blocks', (req, res) => {
  const page = db.prepare('SELECT * FROM base_interface_pages WHERE id = ?').get(req.params.pageId)
  if (!page) return res.status(404).json({ error: 'Page introuvable' })

  const iface = db.prepare('SELECT * FROM base_interfaces WHERE id = ? AND tenant_id = ?').get(page.interface_id, req.user.tenant_id)
  if (!iface) return res.status(403).json({ error: 'Accès refusé' })

  const { type, config, grid_x, grid_y, grid_w, grid_h } = req.body
  if (!ALLOWED_BLOCK_TYPES.includes(type)) {
    return res.status(400).json({ error: `Type invalide. Types autorisés : ${ALLOWED_BLOCK_TYPES.join(', ')}` })
  }

  const defaults = DEFAULT_SIZES[type] || { w: 4, h: 4 }
  const maxY = db.prepare('SELECT COALESCE(MAX(y + h), 0) as m FROM base_interface_blocks WHERE page_id = ?').get(req.params.pageId)?.m ?? 0

  const id = newId('block')
  db.prepare(`
    INSERT INTO base_interface_blocks (id, page_id, type, config, x, y, w, h)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    req.params.pageId,
    type,
    JSON.stringify(config || {}),
    grid_x ?? 0,
    grid_y ?? maxY,
    grid_w ?? defaults.w,
    grid_h ?? defaults.h,
  )

  res.status(201).json(mapBlock(db.prepare('SELECT * FROM base_interface_blocks WHERE id = ?').get(id)))
})

// PATCH /api/interface-blocks/:id → mounted at /blocks/:blockId
router.patch('/blocks/:blockId', (req, res) => {
  const block = db.prepare('SELECT * FROM base_interface_blocks WHERE id = ?').get(req.params.blockId)
  if (!block) return res.status(404).json({ error: 'Bloc introuvable' })

  const page = db.prepare('SELECT * FROM base_interface_pages WHERE id = ?').get(block.page_id)
  const iface = db.prepare('SELECT * FROM base_interfaces WHERE id = ? AND tenant_id = ?').get(page.interface_id, req.user.tenant_id)
  if (!iface) return res.status(403).json({ error: 'Accès refusé' })

  const { config, grid_x, grid_y, grid_w, grid_h, condition } = req.body
  const fields = []
  const params = []

  if (config !== undefined) {
    const merged = { ...JSON.parse(block.config || '{}'), ...config }
    fields.push('config = ?'); params.push(JSON.stringify(merged))
  }
  if (grid_x !== undefined) { fields.push('x = ?'); params.push(grid_x) }
  if (grid_y !== undefined) { fields.push('y = ?'); params.push(grid_y) }
  if (grid_w !== undefined) { fields.push('w = ?'); params.push(grid_w) }
  if (grid_h !== undefined) { fields.push('h = ?'); params.push(grid_h) }
  if (condition !== undefined) { fields.push('condition = ?'); params.push(condition ? JSON.stringify(condition) : null) }

  if (fields.length === 0) return res.json(mapBlock(block))

  fields.push("updated_at = datetime('now')")
  params.push(req.params.blockId)
  db.prepare(`UPDATE base_interface_blocks SET ${fields.join(', ')} WHERE id = ?`).run(...params)

  res.json(mapBlock(db.prepare('SELECT * FROM base_interface_blocks WHERE id = ?').get(req.params.blockId)))
})

// DELETE /api/interface-blocks/:id
router.delete('/blocks/:blockId', (req, res) => {
  const block = db.prepare('SELECT * FROM base_interface_blocks WHERE id = ?').get(req.params.blockId)
  if (!block) return res.status(404).json({ error: 'Bloc introuvable' })

  const page = db.prepare('SELECT * FROM base_interface_pages WHERE id = ?').get(block.page_id)
  const iface = db.prepare('SELECT * FROM base_interfaces WHERE id = ? AND tenant_id = ?').get(page.interface_id, req.user.tenant_id)
  if (!iface) return res.status(403).json({ error: 'Accès refusé' })

  db.prepare('DELETE FROM base_interface_blocks WHERE id = ?').run(req.params.blockId)
  res.json({ success: true })
})

// PATCH /api/interface-pages/:id/blocks/layout
router.patch('/pages/:pageId/blocks/layout', (req, res) => {
  const page = db.prepare('SELECT * FROM base_interface_pages WHERE id = ?').get(req.params.pageId)
  if (!page) return res.status(404).json({ error: 'Page introuvable' })

  const iface = db.prepare('SELECT * FROM base_interfaces WHERE id = ? AND tenant_id = ?').get(page.interface_id, req.user.tenant_id)
  if (!iface) return res.status(403).json({ error: 'Accès refusé' })

  const updates = req.body // [{ id, grid_x, grid_y, grid_w, grid_h }]
  const update = db.prepare('UPDATE base_interface_blocks SET x = ?, y = ?, w = ?, h = ? WHERE id = ? AND page_id = ?')
  const run = db.transaction(() =>
    updates.forEach(u => update.run(u.grid_x, u.grid_y, u.grid_w, u.grid_h, u.id, req.params.pageId))
  )
  run()
  res.json({ success: true })
})

// ── Block data endpoint ────────────────────────────────────────────────────

router.get('/blocks/:blockId/data', async (req, res) => {
  const block = db.prepare('SELECT * FROM base_interface_blocks WHERE id = ?').get(req.params.blockId)
  if (!block) return res.status(404).json({ error: 'Bloc introuvable' })

  const page = db.prepare('SELECT * FROM base_interface_pages WHERE id = ?').get(block.page_id)
  const iface = db.prepare('SELECT * FROM base_interfaces WHERE id = ?').get(page.interface_id)
  const roles = JSON.parse(iface.role_access || '[]')
  if (roles.length > 0 && !roles.includes(req.user.role)) {
    return res.status(403).json({ error: 'Accès refusé' })
  }

  const config = JSON.parse(block.config || '{}')
  const filterValues = req.query.filter_values ? JSON.parse(req.query.filter_values) : {}
  const tenantId = req.user.tenant_id

  try {
    switch (block.type) {
      case 'metric':
        return res.json(await computeMetricData(db, config, filterValues, tenantId))
      case 'chart':
        return res.json(await computeChartData(db, config, filterValues, tenantId))
      case 'list':
        return res.json(await computeListData(db, config, filterValues, tenantId))
      default:
        return res.json({ error: 'Type de bloc sans données' })
    }
  } catch (err) {
    console.error('Block data error:', err)
    return res.status(500).json({ error: 'Erreur de calcul' })
  }
})

export default router
