import { Router } from 'express'
import { randomUUID } from 'crypto'
import db from '../db/database.js'
import { getStripeClient, ensureStripeCustomer } from '../services/stripeInvoices.js'

const router = Router()

// Validate a Checkout Session id by retrieving it from Stripe and confirming
// payment_status === 'paid'. Returns { session, invoice } or throws.
async function validateSession(sessionId) {
  const stripe = getStripeClient()
  const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['invoice'] })
  if (session.payment_status !== 'paid') throw new Error('not_paid')
  const invoice = typeof session.invoice === 'object' ? session.invoice : (session.invoice ? await stripe.invoices.retrieve(session.invoice) : null)
  return { session, invoice }
}

// Detect ERP product roles from invoice line items by reading the Stripe
// product's metadata.erp_product_id (which we set when building the Checkout
// Session). The new Stripe API exposes the product id via
// `lines.data.pricing.price_details.product` (string) and doesn't support
// expanding it inline — so we retrieve each unique product separately.
async function detectProductRoles(invoice, stripe) {
  if (!invoice?.lines?.data) return []
  const stripeProductIds = []
  for (const li of invoice.lines.data) {
    const pid = li.pricing?.price_details?.product
      || (typeof li.price?.product === 'string' ? li.price.product : li.price?.product?.id)
      || null
    if (pid && !stripeProductIds.includes(pid)) stripeProductIds.push(pid)
  }
  if (stripeProductIds.length === 0) return []
  const erpIds = []
  for (const sid of stripeProductIds) {
    try {
      const p = await stripe.products.retrieve(sid)
      const erpId = p.metadata?.erp_product_id
      if (erpId && !erpIds.includes(erpId)) erpIds.push(erpId)
    } catch { /* ignore */ }
  }
  if (erpIds.length === 0) return []
  const placeholders = erpIds.map(() => '?').join(',')
  const rows = db.prepare(`SELECT id, role FROM products WHERE role IS NOT NULL AND id IN (${placeholders})`).all(...erpIds)
  return rows.map(r => r.role)
}

function loadOrInitResponse(sessionId, invoice) {
  let row = db.prepare('SELECT * FROM customer_onboarding_responses WHERE stripe_session_id=?').get(sessionId)
  if (row) return row
  // Look up the company via metadata
  const pendingId = invoice?.metadata?.erp_pending_invoice_id || null
  let companyId = null
  if (pendingId) {
    const pending = db.prepare('SELECT company_id FROM pending_invoices WHERE id=?').get(pendingId)
    companyId = pending?.company_id || null
  }
  const id = randomUUID()
  db.prepare(`
    INSERT INTO customer_onboarding_responses
      (id, stripe_session_id, stripe_invoice_id, pending_invoice_id, company_id, status)
    VALUES (?,?,?,?,?, 'in_progress')
  `).run(id, sessionId, invoice?.id || null, pendingId, companyId)
  return db.prepare('SELECT * FROM customer_onboarding_responses WHERE id=?').get(id)
}

function shapeResponse(row) {
  if (!row) return null
  return {
    id: row.id,
    status: row.status,
    is_new_site: row.is_new_site,
    farm_address: row.farm_address_json ? JSON.parse(row.farm_address_json) : null,
    shipping_same_as_farm: row.shipping_same_as_farm == null ? null : !!row.shipping_same_as_farm,
    shipping_address: row.shipping_address_json ? JSON.parse(row.shipping_address_json) : null,
    network_access: row.network_access,
    wifi_ssid: row.wifi_ssid,
    wifi_password: row.wifi_password,
    permission_level: row.permission_level,
    num_greenhouses: row.num_greenhouses,
    greenhouses: row.greenhouses_json ? JSON.parse(row.greenhouses_json) : [],
    extras: row.extras_json ? JSON.parse(row.extras_json) : [],
    extras_pending_invoice_id: row.extras_pending_invoice_id,
    submitted_at: row.submitted_at,
  }
}

function loadCompanyContext(companyId) {
  if (!companyId) return { farm_address: null, shipping_address: null }
  const farm = db.prepare(`
    SELECT line1, city, province, postal_code, country
    FROM adresses WHERE company_id=? AND address_type='Ferme' AND province IS NOT NULL AND province!=''
    ORDER BY created_at DESC LIMIT 1
  `).get(companyId)
  const ship = db.prepare(`
    SELECT line1, city, province, postal_code, country
    FROM adresses WHERE company_id=? AND address_type='Livraison' AND province IS NOT NULL AND province!=''
    ORDER BY created_at DESC LIMIT 1
  `).get(companyId)
  return { farm_address: farm || null, shipping_address: ship || null }
}

// GET /api/customer/post-payment/:sessionId — main wizard payload
router.get('/:sessionId', async (req, res) => {
  try {
    const { session, invoice } = await validateSession(req.params.sessionId)
    const roles = await detectProductRoles(invoice, getStripeClient())
    const row = loadOrInitResponse(req.params.sessionId, invoice)

    // Pre-detect permission level if not yet saved
    if (!row.permission_level) {
      const detectedPermission = roles.includes('chief_grower') ? 'chief_grower' : roles.includes('helper') ? 'helper' : null
      if (detectedPermission) {
        db.prepare('UPDATE customer_onboarding_responses SET permission_level=? WHERE id=?').run(detectedPermission, row.id)
        row.permission_level = detectedPermission
      }
    }

    const ctx = loadCompanyContext(row.company_id)

    res.json({
      session_id: session.id,
      invoice: invoice ? {
        id: invoice.id, number: invoice.number, total: invoice.total, currency: invoice.currency,
        hosted_invoice_url: invoice.hosted_invoice_url, pdf_url: invoice.invoice_pdf,
      } : null,
      customer_email: session.customer_details?.email || null,
      detected: {
        has_helper: roles.includes('helper'),
        has_chief_grower: roles.includes('chief_grower'),
        has_mobile_controller: roles.includes('mobile_controller'),
        permission_level: roles.includes('chief_grower') ? 'chief_grower' : roles.includes('helper') ? 'helper' : null,
      },
      context: ctx,
      response: shapeResponse(row),
    })
  } catch (e) {
    if (e.message === 'not_paid') return res.status(402).json({ error: 'Paiement non confirmé' })
    if (e.raw?.code === 'resource_missing') return res.status(404).json({ error: 'Session introuvable' })
    res.status(500).json({ error: e.message })
  }
})

// POST /api/customer/post-payment/:sessionId/save — autosave partial state
router.post('/:sessionId/save', async (req, res) => {
  try {
    const { session, invoice } = await validateSession(req.params.sessionId)
    const row = loadOrInitResponse(req.params.sessionId, invoice)
    if (row.status === 'submitted') return res.status(400).json({ error: 'Déjà soumis' })

    const allowed = {
      is_new_site: v => (v === 'new' || v === 'add_to_existing') ? v : null,
      farm_address: v => v && typeof v === 'object' ? JSON.stringify(v) : null,
      shipping_same_as_farm: v => v == null ? null : (v ? 1 : 0),
      shipping_address: v => v && typeof v === 'object' ? JSON.stringify(v) : null,
      network_access: v => typeof v === 'string' ? v : null,
      wifi_ssid: v => v == null ? null : String(v),
      wifi_password: v => v == null ? null : String(v),
      num_greenhouses: v => v == null ? null : Math.max(0, parseInt(v) || 0),
      greenhouses: v => Array.isArray(v) ? JSON.stringify(v) : null,
      extras: v => Array.isArray(v) ? JSON.stringify(v) : null,
    }

    const updates = []
    const values = []
    for (const [key, coerce] of Object.entries(allowed)) {
      if (key in (req.body || {})) {
        const dbKey = ['farm_address', 'shipping_address', 'greenhouses', 'extras'].includes(key) ? `${key === 'greenhouses' ? 'greenhouses' : key === 'extras' ? 'extras' : key + '_address'}_json`
          : key
        // Map JSON column names
        const finalKey = key === 'farm_address' ? 'farm_address_json'
          : key === 'shipping_address' ? 'shipping_address_json'
          : key === 'greenhouses' ? 'greenhouses_json'
          : key === 'extras' ? 'extras_json'
          : key
        updates.push(`${finalKey}=?`)
        values.push(coerce(req.body[key]))
      }
    }
    if (updates.length === 0) return res.json({ ok: true, saved: 0 })
    updates.push("updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')")
    values.push(row.id)
    db.prepare(`UPDATE customer_onboarding_responses SET ${updates.join(', ')} WHERE id=?`).run(...values)
    const refreshed = db.prepare('SELECT * FROM customer_onboarding_responses WHERE id=?').get(row.id)
    res.json({ ok: true, response: shapeResponse(refreshed) })
  } catch (e) {
    if (e.message === 'not_paid') return res.status(402).json({ error: 'Paiement non confirmé' })
    res.status(500).json({ error: e.message })
  }
})

// POST /api/customer/post-payment/:sessionId/submit — finalize
// Writes the addresses to the company's `adresses` table (upsert by type),
// marks the response as submitted.
router.post('/:sessionId/submit', async (req, res) => {
  try {
    const { invoice } = await validateSession(req.params.sessionId)
    const row = loadOrInitResponse(req.params.sessionId, invoice)
    if (row.status === 'submitted') {
      return res.json({ ok: true, already_submitted: true, response: shapeResponse(row) })
    }
    if (!row.is_new_site) return res.status(400).json({ error: 'is_new_site requis avant soumission' })

    // Upsert addresses if company is known
    if (row.company_id) {
      const farm = row.farm_address_json ? JSON.parse(row.farm_address_json) : null
      const ship = row.shipping_address_json ? JSON.parse(row.shipping_address_json) : null
      const sameAsShipping = !!row.shipping_same_as_farm

      function upsertAddress(type, addr) {
        if (!addr || !addr.line1 || !addr.province) return
        const existing = db.prepare(
          "SELECT id FROM adresses WHERE company_id=? AND address_type=? ORDER BY created_at DESC LIMIT 1"
        ).get(row.company_id, type)
        if (existing) {
          db.prepare(`UPDATE adresses SET line1=?, city=?, province=?, postal_code=?, country=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
            .run(addr.line1, addr.city || null, addr.province, addr.postal_code || null, addr.country || 'Canada', existing.id)
        } else {
          db.prepare(`INSERT INTO adresses (id, company_id, address_type, line1, city, province, postal_code, country) VALUES (?,?,?,?,?,?,?,?)`)
            .run(randomUUID(), row.company_id, type, addr.line1, addr.city || null, addr.province, addr.postal_code || null, addr.country || 'Canada')
        }
      }

      if (row.is_new_site === 'new' && farm) upsertAddress('Ferme', farm)
      if (row.is_new_site === 'new' && sameAsShipping && farm) upsertAddress('Livraison', farm)
      else if (ship) upsertAddress('Livraison', ship)
    }

    db.prepare(`UPDATE customer_onboarding_responses SET status='submitted', submitted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(row.id)
    const refreshed = db.prepare('SELECT * FROM customer_onboarding_responses WHERE id=?').get(row.id)
    res.json({ ok: true, response: shapeResponse(refreshed) })
  } catch (e) {
    if (e.message === 'not_paid') return res.status(402).json({ error: 'Paiement non confirmé' })
    res.status(500).json({ error: e.message })
  }
})

// POST /api/customer/post-payment/:sessionId/extras — create a follow-up
// pending_invoice for items the customer wants to buy as extras.
// Body: { items: [{ role, qty, unit_price, description }] }
//   role examples: 'mobile_controller', 'valve_block_onetime', 'valve_block_sub', 'valve_1in', 'guide_pipe'
//   unit_price is enforced server-side from the catalog price (no client trust)
router.post('/:sessionId/extras', async (req, res) => {
  try {
    const { invoice } = await validateSession(req.params.sessionId)
    const row = loadOrInitResponse(req.params.sessionId, invoice)
    if (!row.company_id) return res.status(400).json({ error: 'Aucune entreprise associée à cette commande' })

    const { items } = req.body || {}
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items requis' })

    // Resolve each role to a product + price
    const resolved = []
    for (const it of items) {
      if (!it?.role || !Number.isFinite(Number(it.qty)) || Number(it.qty) <= 0) continue
      const product = db.prepare("SELECT id, sku, name_fr, price_cad, monthly_price_cad FROM products WHERE role=? AND active=1 LIMIT 1").get(it.role)
      if (!product) continue
      const isSubscription = it.role === 'valve_block_sub'
      const unitPrice = isSubscription ? Number(product.monthly_price_cad || 0) : Number(product.price_cad || 0)
      // Skip items with $0 price (likely placeholders)
      if (unitPrice <= 0) continue
      resolved.push({
        product_id: product.id,
        qty: Math.floor(Number(it.qty)),
        unit_price: unitPrice,
        description: it.description || product.name_fr || product.sku || it.role,
      })
    }
    if (resolved.length === 0) return res.status(400).json({ error: 'Aucun extra valide à facturer' })

    // Resolve company shipping for the new pending_invoice
    const ship = db.prepare(`SELECT province, country FROM adresses WHERE company_id=? AND address_type='Livraison' AND province IS NOT NULL AND province!='' ORDER BY created_at DESC LIMIT 1`).get(row.company_id)
    const province = ship?.province || (row.shipping_address_json ? JSON.parse(row.shipping_address_json)?.province : null)
      || (row.farm_address_json ? JSON.parse(row.farm_address_json)?.province : null)
    if (!province) return res.status(400).json({ error: 'Aucune province de livraison déterminée — soumettez d\'abord vos adresses' })
    const country = ship?.country || 'Canada'

    // Create pending invoice
    const id = randomUUID()
    db.prepare(`
      INSERT INTO pending_invoices (id, company_id, currency, items_json, shipping_province, shipping_country, due_days, status, created_by)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(id, row.company_id, 'CAD', JSON.stringify(resolved), province, country, 30, 'sent', null)

    db.prepare(`UPDATE customer_onboarding_responses SET extras_pending_invoice_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(id, row.id)

    // Create the Checkout Session immediately so we can redirect right away
    const stripe = getStripeClient()
    const { createOrRefreshCheckoutSession } = await import('../services/stripeInvoices.js')
    const baseUrl = (process.env.APP_URL || 'https://customer.orisha.io').replace(/\/$/, '')
    const pending = db.prepare('SELECT * FROM pending_invoices WHERE id=?').get(id)
    const { url } = await createOrRefreshCheckoutSession({ stripe, pending, baseAppUrl: baseUrl })
    // Make sure the customer has a Stripe customer id
    await ensureStripeCustomer(stripe, row.company_id).catch(() => {})

    res.json({ ok: true, pending_invoice_id: id, checkout_url: url, pay_url: `${baseUrl}/erp/pay/${id}` })
  } catch (e) {
    if (e.message === 'not_paid') return res.status(402).json({ error: 'Paiement non confirmé' })
    res.status(500).json({ error: e.message })
  }
})

export default router
