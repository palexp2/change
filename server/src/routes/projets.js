import { Router } from 'express'
import { randomUUID } from 'crypto'
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
  let where = 'WHERE 1=1'
  const params = []
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
    WHERE s.id = ?
  `).get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  res.json(row)
})

// ── Adresses ─────────────────────────────────────────────────────────────────

router.get('/adresses', (req, res) => {
  const { company_id, contact_id, address_type, page = 1, limit = 50 } = req.query
  const limitAll = limit === 'all'
  const limitVal = limitAll ? -1 : parseInt(limit)
  const offset = limitAll ? 0 : (parseInt(page) - 1) * parseInt(limit)
  let where = 'WHERE 1=1'
  const params = []
  if (company_id) {
    where += ' AND a.company_id = ?'
    params.push(company_id)
  } else if (contact_id) {
    where += ' AND a.contact_id = ?'; params.push(contact_id)
  }
  if (address_type) { where += ' AND a.address_type = ?'; params.push(address_type) }

  const total = db.prepare(`SELECT COUNT(*) as c FROM adresses a ${where}`).get(...params).c
  const rows = db.prepare(`
    SELECT a.*, co.name as company_name, ct.first_name || ' ' || ct.last_name as contact_name
    FROM adresses a
    LEFT JOIN companies co ON a.company_id = co.id
    LEFT JOIN contacts ct ON a.contact_id = ct.id
    ${where}
    ORDER BY a.address_type ASC, a.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limitVal, offset)

  res.json({ data: rows, total, page: parseInt(page), limit: parseInt(limit) })
})

router.get('/adresses/:id', (req, res) => {
  const row = db.prepare(`
    SELECT a.*, co.name as company_name
    FROM adresses a
    LEFT JOIN companies co ON a.company_id = co.id
    WHERE a.id = ?
  `).get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  res.json(row)
})

router.post('/adresses', (req, res) => {
  const { line1, city, province, postal_code, country, address_type, company_id, contact_id, language } = req.body
  const id = randomUUID()
  db.prepare(`INSERT INTO adresses (id, line1, city, province, postal_code, country, address_type, company_id, contact_id, language)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, line1||null, city||null, province||null, postal_code||null, country||null, address_type||null, company_id||null, contact_id||null, language||null)
  res.json(db.prepare('SELECT * FROM adresses WHERE id = ?').get(id))
})

router.put('/adresses/:id', (req, res) => {
  const { line1, city, province, postal_code, country, address_type, contact_id } = req.body
  db.prepare(`UPDATE adresses SET line1=?, city=?, province=?, postal_code=?, country=?, address_type=?, contact_id=?, updated_at=datetime('now')
    WHERE id = ?`)
    .run(line1||null, city||null, province||null, postal_code||null, country||null, address_type||null, contact_id||null, req.params.id)
  res.json(db.prepare('SELECT * FROM adresses WHERE id = ?').get(req.params.id))
})

router.delete('/adresses/:id', (req, res) => {
  db.prepare('DELETE FROM adresses WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
})

// ── BOM Items ────────────────────────────────────────────────────────────────

router.get('/bom', (req, res) => {
  const { product_id, component_id, page = 1, limit = 50 } = req.query
  const limitAll = limit === 'all'
  const limitVal = limitAll ? -1 : parseInt(limit)
  const offset = limitAll ? 0 : (parseInt(page) - 1) * parseInt(limit)
  let where = 'WHERE 1=1'
  const params = []
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
    WHERE b.id = ?
  `).get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  res.json(row)
})

// ── Serial State Changes ─────────────────────────────────────────────────────

router.get('/serial-changes', (req, res) => {
  const { serial_id, page = 1, limit = 50 } = req.query
  const limitAll = limit === 'all'
  const limitVal = limitAll ? -1 : parseInt(limit)
  const offset = limitAll ? 0 : (parseInt(page) - 1) * parseInt(limit)
  let where = 'WHERE 1=1'
  const params = []
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
  let where = 'WHERE 1=1'
  const params = []
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
    WHERE a.id = ?
  `).get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  res.json(row)
})

// ── Factures ─────────────────────────────────────────────────────────────────

router.get('/factures', (req, res) => {
  const { company_id, project_id, status, page = 1, limit = 50 } = req.query
  const limitAll = limit === 'all'
  const limitVal = limitAll ? -1 : parseInt(limit)
  const offset = limitAll ? 0 : (parseInt(page) - 1) * parseInt(limit)
  let where = 'WHERE 1=1'
  const params = []
  if (company_id) { where += ' AND f.company_id = ?'; params.push(company_id) }
  if (project_id) {
    // Direct link OR linked via an order belonging to this project
    where += ' AND (f.project_id = ? OR f.order_id IN (SELECT id FROM orders WHERE project_id = ?))'
    params.push(project_id, project_id)
  }
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
    SELECT f.*, co.name as company_name, p.name as project_name,
      o.order_number, o.id as order_id_resolved,
      s.stripe_id as subscription_stripe_id
    FROM factures f
    LEFT JOIN companies co ON f.company_id = co.id
    LEFT JOIN projects p ON f.project_id = p.id
    LEFT JOIN orders o ON f.order_id = o.id
    LEFT JOIN subscriptions s ON f.subscription_id = s.id
    WHERE f.id = ?
  `).get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  res.json(row)
})

router.get('/factures/:id/pdf', (req, res) => {
  const row = db.prepare('SELECT airtable_pdf_path FROM factures WHERE id=?').get(req.params.id)
  if (!row?.airtable_pdf_path) return res.status(404).json({ error: 'PDF non disponible' })
  res.sendFile(row.airtable_pdf_path)
})

router.patch('/factures/:id', (req, res) => {
  const { project_id } = req.body
  const existing = db.prepare('SELECT id FROM factures WHERE id = ?').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })
  db.prepare(`UPDATE factures SET project_id=?, updated_at=datetime('now') WHERE id = ?`)
    .run(project_id || null, req.params.id)
  const row = db.prepare(`
    SELECT f.*, co.name as company_name, p.name as project_name
    FROM factures f
    LEFT JOIN companies co ON f.company_id = co.id
    LEFT JOIN projects p ON f.project_id = p.id
    WHERE f.id = ?
  `).get(req.params.id)
  res.json(row)
})

// ── Retours ──────────────────────────────────────────────────────────────────

router.get('/retours', (req, res) => {
  const { company_id, processing_status, page = 1, limit = 50 } = req.query
  const limitAll = limit === 'all'
  const limitVal = limitAll ? -1 : parseInt(limit)
  const offset = limitAll ? 0 : (parseInt(page) - 1) * parseInt(limit)
  let where = 'WHERE 1=1'
  const params = []
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
    WHERE r.id = ?
  `).get(req.params.id)
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
  const { company_id, status, page = 1, limit = 50 } = req.query
  const limitAll = limit === 'all'
  const limitVal = limitAll ? -1 : parseInt(limit)
  const offset = limitAll ? 0 : (parseInt(page) - 1) * parseInt(limit)
  let where = 'WHERE 1=1'
  const params = []
  if (company_id) { where += ' AND s.company_id = ?'; params.push(company_id) }
  if (status) { where += ' AND s.status = ?'; params.push(status) }

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
    WHERE s.id = ?
  `).get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  res.json(row)
})

router.patch('/abonnements/:id', (req, res) => {
  const { rachat } = req.body
  const VALID = ['rachat complet', 'rachat partiel', 'fusion', null]
  if (!VALID.includes(rachat)) return res.status(400).json({ error: 'Valeur invalide' })
  const existing = db.prepare('SELECT id FROM subscriptions WHERE id=?')
    .get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })
  db.prepare('UPDATE subscriptions SET rachat=? WHERE id=?').run(rachat, req.params.id)
  res.json({ ok: true })
})

export default router
