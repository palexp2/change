import { Router } from 'express'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

// ── Soumissions ──────────────────────────────────────────────────────────────

router.get('/soumissions', (req, res) => {
  const { project_id, page = 1, limit = 50 } = req.query
  const limitAll = limit === 'all'
  const limitVal = limitAll ? -1 : parseInt(limit)
  const offset = limitAll ? 0 : (parseInt(page) - 1) * parseInt(limit)
  const tid = req.user.tenant_id

  let where = 'WHERE s.tenant_id = ?'
  const params = [tid]
  if (project_id) { where += ' AND s.project_id = ?'; params.push(project_id) }

  const total = db.prepare(`SELECT COUNT(*) as c FROM soumissions s ${where}`).get(...params).c
  const rows = db.prepare(`
    SELECT s.*, p.name as project_name
    FROM soumissions s
    LEFT JOIN projects p ON s.project_id = p.id
    ${where}
    ORDER BY s.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limitVal, offset)

  res.json({ data: rows, total, page: parseInt(page), limit: parseInt(limit) })
})

router.get('/soumissions/:id', (req, res) => {
  const row = db.prepare(`
    SELECT s.*, p.name as project_name
    FROM soumissions s
    LEFT JOIN projects p ON s.project_id = p.id
    WHERE s.id = ? AND s.tenant_id = ?
  `).get(req.params.id, req.user.tenant_id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  res.json(row)
})

// ── Adresses ─────────────────────────────────────────────────────────────────

router.get('/adresses', (req, res) => {
  const { company_id, contact_id, address_type, page = 1, limit = 50 } = req.query
  const limitAll = limit === 'all'
  const limitVal = limitAll ? -1 : parseInt(limit)
  const offset = limitAll ? 0 : (parseInt(page) - 1) * parseInt(limit)
  const tid = req.user.tenant_id

  let where = 'WHERE a.tenant_id = ?'
  const params = [tid]
  if (company_id) { where += ' AND a.company_id = ?'; params.push(company_id) }
  if (contact_id) { where += ' AND a.contact_id = ?'; params.push(contact_id) }
  if (address_type) { where += ' AND a.address_type = ?'; params.push(address_type) }

  const total = db.prepare(`SELECT COUNT(*) as c FROM adresses a ${where}`).get(...params).c
  const rows = db.prepare(`
    SELECT a.*, co.name as company_name
    FROM adresses a
    LEFT JOIN companies co ON a.company_id = co.id
    ${where}
    ORDER BY a.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limitVal, offset)

  res.json({ data: rows, total, page: parseInt(page), limit: parseInt(limit) })
})

router.get('/adresses/:id', (req, res) => {
  const row = db.prepare(`
    SELECT a.*, co.name as company_name
    FROM adresses a
    LEFT JOIN companies co ON a.company_id = co.id
    WHERE a.id = ? AND a.tenant_id = ?
  `).get(req.params.id, req.user.tenant_id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  res.json(row)
})

// ── BOM Items ────────────────────────────────────────────────────────────────

router.get('/bom', (req, res) => {
  const { product_id, component_id, page = 1, limit = 50 } = req.query
  const limitAll = limit === 'all'
  const limitVal = limitAll ? -1 : parseInt(limit)
  const offset = limitAll ? 0 : (parseInt(page) - 1) * parseInt(limit)
  const tid = req.user.tenant_id

  let where = 'WHERE b.tenant_id = ?'
  const params = [tid]
  if (product_id) { where += ' AND b.product_id = ?'; params.push(product_id) }
  if (component_id) { where += ' AND b.component_id = ?'; params.push(component_id) }

  const total = db.prepare(`SELECT COUNT(*) as c FROM bom_items b ${where}`).get(...params).c
  const rows = db.prepare(`
    SELECT b.*,
      p.name_fr as product_name, p.sku as product_sku,
      c.name_fr as component_name, c.sku as component_sku
    FROM bom_items b
    LEFT JOIN products p ON b.product_id = p.id
    LEFT JOIN products c ON b.component_id = c.id
    ${where}
    ORDER BY p.sku, b.ref_des
    LIMIT ? OFFSET ?
  `).all(...params, limitVal, offset)

  res.json({ data: rows, total, page: parseInt(page), limit: parseInt(limit) })
})

router.get('/bom/:id', (req, res) => {
  const row = db.prepare(`
    SELECT b.*,
      p.name_fr as product_name, p.sku as product_sku,
      c.name_fr as component_name, c.sku as component_sku
    FROM bom_items b
    LEFT JOIN products p ON b.product_id = p.id
    LEFT JOIN products c ON b.component_id = c.id
    WHERE b.id = ? AND b.tenant_id = ?
  `).get(req.params.id, req.user.tenant_id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  res.json(row)
})

// ── Serial State Changes ─────────────────────────────────────────────────────

router.get('/serial-changes', (req, res) => {
  const { serial_id, page = 1, limit = 50 } = req.query
  const limitAll = limit === 'all'
  const limitVal = limitAll ? -1 : parseInt(limit)
  const offset = limitAll ? 0 : (parseInt(page) - 1) * parseInt(limit)
  const tid = req.user.tenant_id

  let where = 'WHERE sc.tenant_id = ?'
  const params = [tid]
  if (serial_id) { where += ' AND sc.serial_id = ?'; params.push(serial_id) }

  const total = db.prepare(`SELECT COUNT(*) as c FROM serial_state_changes sc ${where}`).get(...params).c
  const rows = db.prepare(`
    SELECT sc.*, sn.serial_number, p.name_fr as product_name, p.sku
    FROM serial_state_changes sc
    LEFT JOIN serial_numbers sn ON sc.serial_id = sn.id
    LEFT JOIN products p ON sn.product_id = p.id
    ${where}
    ORDER BY sc.changed_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limitVal, offset)

  res.json({ data: rows, total, page: parseInt(page), limit: parseInt(limit) })
})

// ── Assemblages ──────────────────────────────────────────────────────────────

router.get('/assemblages', (req, res) => {
  const { product_id, page = 1, limit = 50 } = req.query
  const limitAll = limit === 'all'
  const limitVal = limitAll ? -1 : parseInt(limit)
  const offset = limitAll ? 0 : (parseInt(page) - 1) * parseInt(limit)
  const tid = req.user.tenant_id

  let where = 'WHERE a.tenant_id = ?'
  const params = [tid]
  if (product_id) { where += ' AND a.product_id = ?'; params.push(product_id) }

  const total = db.prepare(`SELECT COUNT(*) as c FROM assemblages a ${where}`).get(...params).c
  const rows = db.prepare(`
    SELECT a.*, p.name_fr as product_name, p.sku
    FROM assemblages a
    LEFT JOIN products p ON a.product_id = p.id
    ${where}
    ORDER BY a.assembled_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limitVal, offset)

  res.json({ data: rows, total, page: parseInt(page), limit: parseInt(limit) })
})

router.get('/assemblages/:id', (req, res) => {
  const row = db.prepare(`
    SELECT a.*, p.name_fr as product_name, p.sku
    FROM assemblages a
    LEFT JOIN products p ON a.product_id = p.id
    WHERE a.id = ? AND a.tenant_id = ?
  `).get(req.params.id, req.user.tenant_id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  res.json(row)
})

// ── Factures ─────────────────────────────────────────────────────────────────

router.get('/factures', (req, res) => {
  const { company_id, project_id, status, page = 1, limit = 50 } = req.query
  const limitAll = limit === 'all'
  const limitVal = limitAll ? -1 : parseInt(limit)
  const offset = limitAll ? 0 : (parseInt(page) - 1) * parseInt(limit)
  const tid = req.user.tenant_id

  let where = 'WHERE f.tenant_id = ?'
  const params = [tid]
  if (company_id) { where += ' AND f.company_id = ?'; params.push(company_id) }
  if (project_id) { where += ' AND f.project_id = ?'; params.push(project_id) }
  if (status) { where += ' AND f.status = ?'; params.push(status) }

  const total = db.prepare(`SELECT COUNT(*) as c FROM factures f ${where}`).get(...params).c
  const rows = db.prepare(`
    SELECT f.*, co.name as company_name, p.name as project_name
    FROM factures f
    LEFT JOIN companies co ON f.company_id = co.id
    LEFT JOIN projects p ON f.project_id = p.id
    ${where}
    ORDER BY f.document_date DESC
    LIMIT ? OFFSET ?
  `).all(...params, limitVal, offset)

  res.json({ data: rows, total, page: parseInt(page), limit: parseInt(limit) })
})

router.get('/factures/:id', (req, res) => {
  const row = db.prepare(`
    SELECT f.*, co.name as company_name, p.name as project_name
    FROM factures f
    LEFT JOIN companies co ON f.company_id = co.id
    LEFT JOIN projects p ON f.project_id = p.id
    WHERE f.id = ? AND f.tenant_id = ?
  `).get(req.params.id, req.user.tenant_id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  res.json(row)
})

// ── Retours ──────────────────────────────────────────────────────────────────

router.get('/retours', (req, res) => {
  const { company_id, processing_status, page = 1, limit = 50 } = req.query
  const limitAll = limit === 'all'
  const limitVal = limitAll ? -1 : parseInt(limit)
  const offset = limitAll ? 0 : (parseInt(page) - 1) * parseInt(limit)
  const tid = req.user.tenant_id

  let where = 'WHERE r.tenant_id = ?'
  const params = [tid]
  if (company_id) { where += ' AND r.company_id = ?'; params.push(company_id) }
  if (processing_status) { where += ' AND r.processing_status = ?'; params.push(processing_status) }

  const total = db.prepare(`SELECT COUNT(*) as c FROM returns r ${where}`).get(...params).c
  const rows = db.prepare(`
    SELECT r.*, co.name as company_name
    FROM returns r
    LEFT JOIN companies co ON r.company_id = co.id
    ${where}
    ORDER BY r.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limitVal, offset)

  res.json({ data: rows, total, page: parseInt(page), limit: parseInt(limit) })
})

router.get('/retours/:id', (req, res) => {
  const row = db.prepare(`
    SELECT r.*, co.name as company_name
    FROM returns r
    LEFT JOIN companies co ON r.company_id = co.id
    WHERE r.id = ? AND r.tenant_id = ?
  `).get(req.params.id, req.user.tenant_id)
  if (!row) return res.status(404).json({ error: 'Not found' })

  const items = db.prepare(`
    SELECT ri.*, sn.serial as serial_number, p.name_fr as product_name, p.sku
    FROM return_items ri
    LEFT JOIN serial_numbers sn ON ri.serial_id = sn.id
    LEFT JOIN products p ON sn.product_id = p.id
    WHERE ri.return_id = ?
    ORDER BY ri.created_at
  `).all(req.params.id)

  res.json({ ...row, items })
})

// ── Abonnements ──────────────────────────────────────────────────────────────

router.get('/abonnements', (req, res) => {
  const { company_id, status, type, page = 1, limit = 50 } = req.query
  const limitAll = limit === 'all'
  const limitVal = limitAll ? -1 : parseInt(limit)
  const offset = limitAll ? 0 : (parseInt(page) - 1) * parseInt(limit)
  const tid = req.user.tenant_id

  let where = 'WHERE s.tenant_id = ?'
  const params = [tid]
  if (company_id) { where += ' AND s.company_id = ?'; params.push(company_id) }
  if (status) { where += ' AND s.status = ?'; params.push(status) }
  if (type) { where += ' AND s.type = ?'; params.push(type) }

  const total = db.prepare(`SELECT COUNT(*) as c FROM subscriptions s ${where}`).get(...params).c
  const rows = db.prepare(`
    SELECT s.*,
      s.amount_monthly as amount_cad,
      s.cancel_date as end_date,
      co.name as company_name
    FROM subscriptions s
    LEFT JOIN companies co ON s.company_id = co.id
    ${where}
    ORDER BY s.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limitVal, offset)

  res.json({ data: rows, total, page: parseInt(page), limit: parseInt(limit) })
})

router.get('/abonnements/:id', (req, res) => {
  const row = db.prepare(`
    SELECT s.*, co.name as company_name
    FROM subscriptions s
    LEFT JOIN companies co ON s.company_id = co.id
    WHERE s.id = ? AND s.tenant_id = ?
  `).get(req.params.id, req.user.tenant_id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  res.json(row)
})

export default router
