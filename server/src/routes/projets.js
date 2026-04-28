import { Router } from 'express'
import { randomUUID } from 'crypto'
import path from 'path'
import Stripe from 'stripe'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { postRevenueRecognitionJE } from '../services/quickbooks.js'

function getStripeKey() {
  const row = db.prepare("SELECT value FROM connector_config WHERE connector='stripe' AND key='secret_key'").get()
  return row?.value || null
}

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
    SELECT s.*, p.name as project_name, co.pays_de_livraison as shipping_country
    FROM soumissions s
    LEFT JOIN projects p ON s.project_id = p.id
    LEFT JOIN companies co ON co.id = p.company_id
    ${where}
    ORDER BY s.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limitVal, offset)

  res.json({ data: rows, total, page: parseInt(page), limit: parseInt(limit) })
})

router.get('/soumissions/:id', (req, res) => {
  const row = db.prepare(`
    SELECT s.*, p.name as project_name, co.pays_de_livraison as shipping_country
    FROM soumissions s
    LEFT JOIN projects p ON s.project_id = p.id
    LEFT JOIN companies co ON co.id = p.company_id
    WHERE s.id = ?
  `).get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  res.json(row)
})

// ── Adresses ─────────────────────────────────────────────────────────────────

// Minimal list for dropdowns — keeps the fields needed to render a label
// (line1/city/province/postal_code/country) and to filter (company_id, contact_id).
router.get('/adresses/lookup', (req, res) => {
  const rows = db.prepare(
    `SELECT id, line1, city, province, postal_code, country, address_type, company_id, contact_id
     FROM adresses
     ORDER BY address_type ASC, created_at DESC`
  ).all()
  res.json(rows)
})

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
  db.prepare(`UPDATE adresses SET line1=?, city=?, province=?, postal_code=?, country=?, address_type=?, contact_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
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
      p.name_fr as product_name, p.sku as product_sku, p.image_url as product_image_url,
      c.name_fr as component_name, c.sku as component_sku, c.image_url as component_image_url
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
      p.name_fr as product_name, p.sku as product_sku, p.image_url as product_image_url,
      c.name_fr as component_name, c.sku as component_sku, c.image_url as component_image_url
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
    where += ' AND (f.project_id = ? OR f.order_id IN (SELECT id FROM orders WHERE project_id = ?))'
    params.push(project_id, project_id)
  }
  if (status) { where += ' AND f.status = ?'; params.push(status) }

  const facturesRows = db.prepare(`
    SELECT f.*, co.name as company_name, p.name as project_name, o.order_number,
           'stripe' AS source
    FROM factures f
    LEFT JOIN companies co ON f.company_id = co.id
    LEFT JOIN projects p ON f.project_id = p.id
    LEFT JOIN orders o ON f.order_id = o.id
    ${where}
  `).all(...params)

  // Pending invoices (drafts + sent but not yet paid). Use the same filters where applicable.
  let pwhere = "WHERE pi.status IN ('draft','sent')"
  const pparams = []
  if (company_id) { pwhere += ' AND pi.company_id = ?'; pparams.push(company_id) }
  // No project_id filter on pending — they're not yet linked to projects.
  // Status filter mapping: 'Draft' → status='draft', 'En attente' → status='sent'.
  if (status === 'Draft') { pwhere += " AND pi.status='draft'" }
  else if (status === 'En attente') { pwhere += " AND pi.status='sent'" }
  else if (status) { pwhere += " AND 1=0" } // any other status filter excludes pending

  const pendingRows = db.prepare(`
    SELECT pi.id, NULL AS airtable_id, NULL AS invoice_id, pi.company_id, NULL AS project_id, NULL AS order_id,
           NULL AS document_number,
           COALESCE(pi.sent_at, pi.created_at) AS document_date,
           NULL AS due_date,
           CASE pi.status WHEN 'draft' THEN 'Draft' WHEN 'sent' THEN 'En attente' END AS status,
           pi.currency,
           (SELECT COALESCE(SUM(json_extract(j.value, '$.qty') * json_extract(j.value, '$.unit_price')), 0)
              FROM json_each(pi.items_json) j) AS amount_before_tax_cad,
           (SELECT COALESCE(SUM(json_extract(j.value, '$.qty') * json_extract(j.value, '$.unit_price')), 0)
              FROM json_each(pi.items_json) j) AS total_amount,
           (SELECT COALESCE(SUM(json_extract(j.value, '$.qty') * json_extract(j.value, '$.unit_price')), 0)
              FROM json_each(pi.items_json) j) AS balance_due,
           NULL AS notes, pi.created_at, pi.updated_at,
           NULL AS generated_pdf_path, NULL AS shipping_country, NULL AS subscription_id, NULL AS airtable_pdf_path,
           co.name AS company_name, NULL AS project_name, NULL AS order_number,
           'pending' AS source
    FROM pending_invoices pi
    LEFT JOIN companies co ON pi.company_id = co.id
    ${pwhere}
  `).all(...pparams)

  // Merge + sort by document_date desc, paginate in JS
  const merged = [...facturesRows, ...pendingRows].sort((a, b) => {
    const da = a.document_date || a.created_at || ''
    const db_ = b.document_date || b.created_at || ''
    return db_.localeCompare(da)
  })
  const total = merged.length
  const sliced = limitAll ? merged : merged.slice(offset, offset + limitVal)
  res.json({ data: sliced, total, page: parseInt(page), limit: parseInt(limit) })
})

router.get('/factures/:id', (req, res) => {
  const row = db.prepare(`
    SELECT f.*, co.name as company_name, p.name as project_name,
      o.order_number, o.id as order_id_resolved,
      s.id as subscription_local_id,
      s.stripe_id as subscription_stripe_id,
      EXISTS (
        SELECT 1
        FROM shipments sh
        LEFT JOIN orders od ON od.id = f.order_id
        LEFT JOIN orders op ON op.project_id = f.project_id AND f.project_id IS NOT NULL
        WHERE sh.order_id = od.id OR sh.order_id = op.id
      ) AS has_linked_shipment
    FROM factures f
    LEFT JOIN companies co ON f.company_id = co.id
    LEFT JOIN projects p ON f.project_id = p.id
    LEFT JOIN orders o ON f.order_id = o.id
    LEFT JOIN subscriptions s ON (f.subscription_id = s.stripe_id OR f.subscription_id = s.id)
    WHERE f.id = ?
  `).get(req.params.id)
  if (row) {
    const techResponses = row.invoice_id ? db.prepare(`
      SELECT r.id, r.product_id, r.responses_json, r.submitted_at,
             p.name_fr AS product_name, p.sku AS product_sku, p.tech_info_fields
      FROM customer_tech_info_responses r
      LEFT JOIN products p ON p.id = r.product_id
      WHERE r.stripe_invoice_id = ?
      ORDER BY r.submitted_at DESC
    `).all(row.invoice_id).map(t => ({
      ...t,
      responses: JSON.parse(t.responses_json || '{}'),
      tech_info_fields: t.tech_info_fields ? JSON.parse(t.tech_info_fields) : [],
    })) : []
    return res.json({ ...row, source: 'stripe', tech_responses: techResponses })
  }
  // Fall back to pending_invoices for unpaid drafts/sent
  const pending = db.prepare(`
    SELECT pi.*, co.name AS company_name
    FROM pending_invoices pi
    LEFT JOIN companies co ON pi.company_id = co.id
    WHERE pi.id = ?
  `).get(req.params.id)
  if (!pending) return res.status(404).json({ error: 'Not found' })
  const items = JSON.parse(pending.items_json || '[]')
  const subtotal = items.reduce((s, it) => s + Number(it.qty) * Number(it.unit_price), 0)
  const baseUrl = (process.env.APP_URL || 'https://customer.orisha.io').replace(/\/$/, '')
  res.json({
    id: pending.id,
    source: 'pending',
    company_id: pending.company_id,
    company_name: pending.company_name,
    document_number: null,
    document_date: pending.sent_at || pending.created_at,
    status: pending.status === 'draft' ? 'Draft' : pending.status === 'sent' ? 'En attente' : pending.status === 'cancelled' ? 'Annulée' : pending.status,
    currency: pending.currency || 'CAD',
    amount_before_tax_cad: subtotal,
    total_amount: subtotal,
    balance_due: subtotal,
    items,
    pay_url: `${baseUrl}/erp/pay/${pending.id}`,
    last_session_url: pending.last_session_url,
    last_session_expires_at: pending.last_session_expires_at,
    pending_status: pending.status, // raw status for the UI
  })
})

router.get('/factures/:id/pdf', (req, res) => {
  const row = db.prepare('SELECT airtable_pdf_path FROM factures WHERE id=?').get(req.params.id)
  if (!row?.airtable_pdf_path) return res.status(404).json({ error: 'PDF non disponible' })
  const uploadsBase = path.resolve(process.cwd(), process.env.UPLOADS_PATH || 'uploads')
  res.sendFile(path.join(uploadsBase, row.airtable_pdf_path))
})

router.patch('/factures/:id', (req, res) => {
  const existing = db.prepare('SELECT id, company_id FROM factures WHERE id = ?').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })

  const updates = []
  const params = []
  if (Object.prototype.hasOwnProperty.call(req.body, 'project_id')) {
    updates.push('project_id=?')
    params.push(req.body.project_id || null)
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'order_id')) {
    const orderId = req.body.order_id || null
    if (orderId) {
      const targetCompanyId = Object.prototype.hasOwnProperty.call(req.body, 'company_id')
        ? (req.body.company_id || null)
        : existing.company_id
      const o = db.prepare('SELECT id, company_id FROM orders WHERE id=? AND deleted_at IS NULL').get(orderId)
      if (!o) return res.status(400).json({ error: 'Commande introuvable' })
      if (targetCompanyId && o.company_id && o.company_id !== targetCompanyId) {
        return res.status(400).json({ error: 'La commande appartient à une autre entreprise' })
      }
    }
    updates.push('order_id=?')
    params.push(orderId)
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'company_id')) {
    const companyId = req.body.company_id || null
    if (companyId) {
      const co = db.prepare('SELECT id FROM companies WHERE id=? AND deleted_at IS NULL').get(companyId)
      if (!co) return res.status(400).json({ error: 'Entreprise introuvable' })
    }
    updates.push('company_id=?')
    params.push(companyId)
    // Si on change l'entreprise, le projet et la commande peuvent ne plus appartenir à la nouvelle entreprise → on les délie.
    if (!Object.prototype.hasOwnProperty.call(req.body, 'project_id')) {
      updates.push('project_id=?')
      params.push(null)
    }
    if (!Object.prototype.hasOwnProperty.call(req.body, 'order_id')) {
      updates.push('order_id=?')
      params.push(null)
    }
  }
  if (updates.length) {
    params.push(req.params.id)
    db.prepare(`UPDATE factures SET ${updates.join(', ')}, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
      .run(...params)
  }
  const row = db.prepare(`
    SELECT f.*, co.name as company_name, p.name as project_name,
      o.order_number
    FROM factures f
    LEFT JOIN companies co ON f.company_id = co.id
    LEFT JOIN projects p ON f.project_id = p.id
    LEFT JOIN orders o ON f.order_id = o.id
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
    SELECT ri.*, sn.serial as serial_number,
           COALESCE(pr.name_fr, psn.name_fr) as product_name,
           COALESCE(pr.sku, psn.sku) as sku,
           pr.name_fr as product_to_receive,
           ps.name_fr as product_to_send
    FROM return_items ri
    LEFT JOIN serial_numbers sn ON ri.serial_id = sn.id
    LEFT JOIN products psn ON sn.product_id = psn.id
    LEFT JOIN products pr ON ri.product_id = pr.id
    LEFT JOIN products ps ON ri.product_send_id = ps.id
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

  const usdRate = db.prepare("SELECT rate FROM fx_rates WHERE pair='USDCAD' ORDER BY date DESC LIMIT 1").get()?.rate || 1.38

  const rows = db.prepare(`
    SELECT s.*,
      s.amount_monthly as amount_raw,
      s.cancel_date as end_date,
      co.name as company_name
    FROM subscriptions s
    LEFT JOIN companies co ON s.company_id = co.id
    ${where}
    ORDER BY s.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limitVal, offset)

  for (const row of rows) {
    row.amount_cad = row.currency === 'USD'
      ? Math.round(row.amount_raw * usdRate * 100) / 100
      : row.amount_raw
  }

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

router.get('/abonnements/:id/stripe-details', async (req, res) => {
  const row = db.prepare('SELECT id, stripe_id FROM subscriptions WHERE id=?').get(req.params.id)
  if (!row?.stripe_id) return res.status(404).json({ error: 'Abonnement ou stripe_id introuvable' })

  const key = getStripeKey()
  if (!key) return res.status(503).json({ error: 'Stripe non configuré' })

  try {
    const stripe = new Stripe(key)

    // Fetch subscription with line items expanded
    const sub = await stripe.subscriptions.retrieve(row.stripe_id, {
      expand: ['items.data.price.product', 'discount.coupon'],
    })

    const items = sub.items.data.map(si => ({
      id: si.id,
      product_name: si.price.product?.name || si.price.nickname || si.price.id,
      description: si.price.product?.description || null,
      unit_amount: si.price.unit_amount ? si.price.unit_amount / 100 : null,
      currency: si.price.currency?.toUpperCase(),
      quantity: si.quantity,
      interval: si.price.recurring?.interval,
      interval_count: si.price.recurring?.interval_count,
      total: si.price.unit_amount ? (si.price.unit_amount / 100) * si.quantity : null,
    }))

    // Local change history (persistent, survives Stripe 30-day event window)
    const localEvents = db.prepare(
      'SELECT * FROM subscription_events WHERE subscription_id=? ORDER BY event_date DESC'
    ).all(row.id)

    const history = localEvents.map(ev => ({
      date: ev.event_date,
      type: ev.event_type,
      changes: JSON.parse(ev.details || '[]'),
    }))

    // Fetch invoices with line items for this subscription
    const invoices = await stripe.invoices.list({
      subscription: row.stripe_id,
      limit: 24,
      expand: ['data.lines'],
    })

    const findLocalFacture = db.prepare(
      `SELECT id FROM factures WHERE document_number = ? OR invoice_id = ? LIMIT 1`
    )

    const invoiceHistory = invoices.data.map(inv => {
      const local = inv.number ? findLocalFacture.get(inv.number, inv.id) : findLocalFacture.get(null, inv.id)
      return {
        date: new Date(inv.created * 1000).toISOString(),
        amount: inv.amount_paid / 100,
        currency: inv.currency?.toUpperCase(),
        status: inv.status,
        pdf: inv.invoice_pdf,
        number: inv.number,
        facture_id: local?.id || null,
        lines: (inv.lines?.data || []).map(li => ({
          description: li.description,
          amount: li.amount / 100,
          quantity: li.quantity,
          proration: li.proration || false,
        })),
      }
    })

    const discount = sub.discount ? {
      name: sub.discount.coupon.name || sub.discount.coupon.id,
      percent_off: sub.discount.coupon.percent_off,
      amount_off: sub.discount.coupon.amount_off ? sub.discount.coupon.amount_off / 100 : null,
    } : null

    res.json({ items, history, invoices: invoiceHistory, discount })
  } catch (e) {
    console.error('Stripe details error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

router.patch('/abonnements/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM subscriptions WHERE id=?').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })

  const updates = []
  const params = []
  if (Object.prototype.hasOwnProperty.call(req.body, 'rachat')) {
    const VALID = ['rachat complet', 'rachat partiel', 'fusion', 'non', null]
    if (!VALID.includes(req.body.rachat)) return res.status(400).json({ error: 'Valeur invalide' })
    updates.push('rachat=?')
    params.push(req.body.rachat)
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'company_id')) {
    const companyId = req.body.company_id || null
    if (companyId) {
      const co = db.prepare('SELECT id FROM companies WHERE id=? AND deleted_at IS NULL').get(companyId)
      if (!co) return res.status(400).json({ error: 'Entreprise introuvable' })
    }
    updates.push('company_id=?')
    params.push(companyId)
  }
  if (updates.length) {
    params.push(req.params.id)
    db.prepare(`UPDATE subscriptions SET ${updates.join(', ')} WHERE id=?`).run(...params)
  }
  res.json({ ok: true })
})

// POST /factures/:id/recognize-revenue
// Crée un Journal Entry dans QB qui débite "Revenus perçus d'avance" (23900) et
// crédite "Ventes" pour le montant HT en revenu reçu d'avance, puis marque la facture.
router.post('/factures/:id/recognize-revenue', async (req, res) => {
  try {
    const out = await postRevenueRecognitionJE(req.params.id)
    const fresh = db.prepare(`
      SELECT f.*, co.name as company_name, p.name as project_name, o.order_number,
        EXISTS (
          SELECT 1 FROM shipments sh
          LEFT JOIN orders od ON od.id = f.order_id
          LEFT JOIN orders op ON op.project_id = f.project_id AND f.project_id IS NOT NULL
          WHERE sh.order_id = od.id OR sh.order_id = op.id
        ) AS has_linked_shipment
      FROM factures f
      LEFT JOIN companies co ON f.company_id = co.id
      LEFT JOIN projects p ON f.project_id = p.id
      LEFT JOIN orders o ON f.order_id = o.id
      WHERE f.id = ?
    `).get(req.params.id)
    res.json({ ...out, facture: fresh })
  } catch (e) {
    res.status(400).json({ error: e.message || 'Erreur lors de la création du Journal Entry' })
  }
})

export default router
