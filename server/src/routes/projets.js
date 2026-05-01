import { Router } from 'express'
import { randomUUID } from 'crypto'
import path from 'path'
import Stripe from 'stripe'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { postRevenueRecognitionJE, reconcileFactureRevenueRecognition } from '../services/quickbooks.js'
import { logSystemRun } from '../services/systemAutomations.js'
import { qbEntityUrl } from '../connectors/quickbooks.js'
import { computeCanadaTaxes } from '../services/taxes.js'

// Calcule les taxes d'une facture (tableau {name, percentage, amount}).
// Stratégie :
//   1. Si on a des `stripe_balance_transactions` agrégeant invoice_tax_gst/qst
//      → on retourne TPS + TVQ (Stripe split QC).
//   2. Sinon, fallback : on calcule via la province d'expédition (ou de la
//      ferme) du client + `amount_before_tax_cad` → split TPS/TVQ ou HST.
//   3. Si rien ne matche, on dérive `total_amount - amount_before_tax_cad`
//      en une seule ligne "Taxes" générique.
function computeFactureTaxes(facture) {
  // 1. Stripe balance transactions
  if (facture.invoice_id) {
    const agg = db.prepare(`
      SELECT
        COALESCE(SUM(invoice_tax_gst), 0) AS gst,
        COALESCE(SUM(invoice_tax_qst), 0) AS qst,
        COUNT(*) AS n
      FROM stripe_balance_transactions
      WHERE stripe_invoice_id = ?
    `).get(facture.invoice_id)
    if (agg && agg.n > 0 && (agg.gst > 0 || agg.qst > 0)) {
      const out = []
      if (agg.gst > 0) out.push({ name: 'TPS', percentage: 5, amount: Math.round(agg.gst * 100) / 100 })
      if (agg.qst > 0) out.push({ name: 'TVQ', percentage: 9.975, amount: Math.round(agg.qst * 100) / 100 })
      return out
    }
  }

  // 2. Province d'expédition du client (Livraison > Ferme)
  let province = null
  let country = 'Canada'
  if (facture.company_id) {
    const ship = db.prepare(`
      SELECT province, country FROM adresses
      WHERE company_id = ? AND address_type = 'Livraison' AND province IS NOT NULL AND province != ''
      ORDER BY created_at DESC LIMIT 1
    `).get(facture.company_id)
    const farm = ship || db.prepare(`
      SELECT province, country FROM adresses
      WHERE company_id = ? AND address_type = 'Ferme' AND province IS NOT NULL AND province != ''
      ORDER BY created_at DESC LIMIT 1
    `).get(facture.company_id)
    if (farm) { province = farm.province; country = farm.country || 'Canada' }
  }
  const subtotal = Number(facture.amount_before_tax_cad) || 0
  if (subtotal > 0 && province) {
    const taxes = computeCanadaTaxes({ province, country, subtotal })
    if (taxes.length > 0) return taxes
  }

  // 3. Fallback : différence brute, sans typage.
  const total = Number(facture.total_amount) || 0
  const diff = Math.round((total - subtotal) * 100) / 100
  if (diff > 0 && subtotal > 0) {
    return [{ name: 'Taxes', percentage: null, amount: diff }]
  }
  return []
}

// Convertit une référence `deferred_revenue_qb_ref` (`salesreceipt:123`,
// `deposit:123`, `journal:123`) en URL profonde vers QB.
function buildQbRefUrl(ref) {
  if (!ref || typeof ref !== 'string') return null
  const idx = ref.indexOf(':')
  if (idx < 0) return null
  const entity = ref.slice(0, idx)
  const id = ref.slice(idx + 1)
  if (!entity || !id) return null
  return qbEntityUrl(entity, id)
}

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
           'stripe' AS source,
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
  // is_sent : « expédié » = shipment sur la commande liée (directement via
  // order_id ou via une commande du projet lié), OU override manuel via
  // is_sent_manual=1. Pending = toujours faux.
  // deferred_revenue_state : "Constaté" si revenue_recognized_at posé,
  // "En attente" si deferred_revenue_at posé sans constat, sinon "—".
  for (const r of merged) {
    r.is_sent = r.has_linked_shipment === 1 || r.is_sent_manual === 1
    if (r.revenue_recognized_at) r.deferred_revenue_state = 'Constaté'
    else if (r.deferred_revenue_at) r.deferred_revenue_state = 'En attente'
    else r.deferred_revenue_state = '—'
  }
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
    // URLs QB calculées : `deferred_revenue_qb_url` (SR ou Deposit qui a posté
    // le revenu reçu d'avance) et `revenue_recognized_qb_url` (JE de constat).
    const deferredQb = row.deferred_revenue_qb_ref ? buildQbRefUrl(row.deferred_revenue_qb_ref) : null
    const recognizedQb = row.revenue_recognized_je_id ? qbEntityUrl('journal', row.revenue_recognized_je_id) : null
    // Résumé du dernier paiement "in" (méthode + date) pour affichage en tête.
    // 1. On regarde d'abord la table `payments` (saisies hors-Stripe ou backfill).
    // 2. Si rien, fallback sur `stripe_balance_transactions` filtré sur cette
    //    facture (charges Stripe — type='charge' ou reporting_category liée).
    const paymentsAgg = db.prepare(`
      SELECT COUNT(*) AS n FROM payments WHERE facture_id = ? AND direction = 'in'
    `).get(req.params.id)
    let lastPaymentIn = null
    let paymentsInCount = paymentsAgg?.n || 0

    if (paymentsInCount > 0) {
      lastPaymentIn = db.prepare(`
        SELECT received_at, method, amount, currency
        FROM payments
        WHERE facture_id = ? AND direction = 'in'
        ORDER BY received_at DESC, created_at DESC LIMIT 1
      `).get(req.params.id)
    } else if (row.invoice_id) {
      // Fallback 1 : `paid_at` populé par le webhook invoice.paid — date exacte
      // du paiement Stripe, disponible immédiatement (pas besoin du payout).
      if (row.paid_at) {
        lastPaymentIn = {
          received_at: row.paid_at,
          method: 'stripe',
          amount: row.paid_amount != null ? row.paid_amount : Number(row.total_amount),
          currency: (row.currency || 'CAD').toUpperCase(),
        }
        paymentsInCount = 1
      } else {
        // Fallback 2 : les charges sont dans stripe_balance_transactions
        // (synchronisées au moment du payout) — utile pour les anciennes
        // factures payées avant l'ajout de paid_at.
        const stripeAgg = db.prepare(`
          SELECT COUNT(*) AS n FROM stripe_balance_transactions
          WHERE stripe_invoice_id = ? AND type = 'charge'
        `).get(row.invoice_id)
        paymentsInCount = stripeAgg?.n || 0
        if (paymentsInCount > 0) {
          const bt = db.prepare(`
            SELECT amount, currency, created_date FROM stripe_balance_transactions
            WHERE stripe_invoice_id = ? AND type = 'charge'
            ORDER BY created_date DESC LIMIT 1
          `).get(row.invoice_id)
          lastPaymentIn = {
            received_at: bt.created_date,
            method: 'stripe',
            amount: Math.round(bt.amount * 100) / 100,
            currency: (bt.currency || 'CAD').toUpperCase(),
          }
        } else if ((row.status === 'Payé' || row.status === 'Payée') && Number(row.balance_due) === 0) {
          // Fallback 3 : la facture est marquée "Payé" mais ni `paid_at` ni
          // balance txns. Cas rare (facture payée AVANT cet ajout, ou webhook
          // raté). Date approximative basée sur updated_at.
          lastPaymentIn = {
            received_at: row.updated_at || row.document_date,
            method: 'stripe',
            amount: Number(row.total_amount) || null,
            currency: (row.currency || 'CAD').toUpperCase(),
            unsynced: true,
          }
          paymentsInCount = 1
        }
      }
    }
    return res.json({
      ...row,
      source: 'stripe',
      tech_responses: techResponses,
      deferred_revenue_qb_url: deferredQb,
      revenue_recognized_qb_url: recognizedQb,
      taxes: computeFactureTaxes(row),
      last_payment_in: lastPaymentIn,
      payments_in_count: paymentsInCount,
      is_sent: row.has_linked_shipment === 1 || row.is_sent_manual === 1,
    })
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
    is_sent: false, // pending invoices : pas encore de commande liée
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

  // Détecte si la mutation peut faire basculer la condition « produits envoyé »
  // (changement order_id, project_id, ou company_id qui délie en cascade).
  const linkMaybeChanged = ['order_id', 'project_id', 'company_id'].some(k =>
    Object.prototype.hasOwnProperty.call(req.body, k)
  )

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
  const wantsForceSent = Object.prototype.hasOwnProperty.call(req.body, 'is_sent_manual')
    && !!req.body.is_sent_manual
  if (Object.prototype.hasOwnProperty.call(req.body, 'is_sent_manual')) {
    updates.push('is_sent_manual=?')
    params.push(req.body.is_sent_manual ? 1 : 0)
  }
  if (updates.length) {
    params.push(req.params.id)
    db.prepare(`UPDATE factures SET ${updates.join(', ')}, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
      .run(...params)
  }

  // Si le rattachement (order/project/company) a changé, la condition « produits
  // envoyé » peut être devenue vraie — on tente le constat de vente. Asynchrone
  // et idempotent : si QB est down ou rien à faire, on n'altère pas la réponse.
  if (linkMaybeChanged) {
    reconcileFactureRevenueRecognition(req.params.id).then(r => {
      if (r.status === 'recognized' || r.status === 'error') {
        logSystemRun('sys_revenue_recognition', {
          status: r.status === 'error' ? 'error' : 'success',
          result: r.status === 'recognized'
            ? `Facture #${r.document_number || r.facture_id} constatée (JE ${r.qb_journal_entry_id} · ${r.amount} ${r.currency} · ${r.debit_account}) — déclenchement: PATCH /factures/${req.params.id}`
            : `Facture #${r.document_number || r.facture_id} — erreur constat: ${r.error}`,
          error: r.status === 'error' ? r.error : undefined,
          triggerData: { facture_id: req.params.id, source: 'patch_facture_link' },
        })
      }
    }).catch(err => {
      console.error('reconcileFactureRevenueRecognition error:', err.message)
      logSystemRun('sys_revenue_recognition', {
        status: 'error', error: err.message,
        triggerData: { facture_id: req.params.id, source: 'patch_facture_link' },
      })
    })
  }

  // Toggle « Envoyée » forcé manuellement (is_sent_manual=true) : déclenche
  // la JE de constat de vente avec bypass du check shipment. Skippe
  // silencieusement si conditions non remplies (déjà constaté, abonnement,
  // facture pending sans Stripe invoice, etc.).
  if (wantsForceSent) {
    const f = db.prepare(
      "SELECT id, document_number, kind, revenue_recognized_at FROM factures WHERE id=?"
    ).get(req.params.id)
    if (f && f.kind !== 'subscription' && !f.revenue_recognized_at) {
      postRevenueRecognitionJE(req.params.id, { bypassShipmentCheck: true })
        .then(r => {
          logSystemRun('sys_revenue_recognition', {
            status: 'success',
            result: `Facture #${f.document_number || req.params.id} constatée via override "Envoyée" forcée (JE ${r.qb_journal_entry_id} · ${r.amount} ${r.currency} · ${r.debit_account})`,
            triggerData: { facture_id: req.params.id, source: 'is_sent_manual' },
          })
        })
        .catch(err => {
          console.error('postRevenueRecognitionJE (is_sent_manual) error:', err.message)
          logSystemRun('sys_revenue_recognition', {
            status: 'error', error: err.message,
            triggerData: { facture_id: req.params.id, source: 'is_sent_manual' },
          })
        })
    }
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
