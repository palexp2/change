import { discoveryAddresses } from '../services/discoveryAddresses.js'
import { discoveryAnswerErrors } from '../services/discoveryAnswerValidation.js'
import { discoveryOptionsFromRow } from '../services/discoveryFormOptions.js'
import { mobileControllerRole } from '../services/discoveryEquipment.js'
import { Router } from 'express'
import { newRecordId } from '../utils/recordId.js'
import db from '../db/database.js'
import { getStripeClient, ensureStripeCustomer } from '../services/stripeInvoices.js'
import { normalizeShortToken } from '../utils/shortToken.js'
import { logSync } from '../services/syncLog.js'
import { APP_URL } from '../config/appUrl.js'
import { loadSchemaOverrides } from './discovery-form-schema.js'
import { confirmAddressInput } from '../services/addressConfirm.js'

// Crée/synchronise le customer Stripe sans bloquer la réponse, mais trace tout
// échec dans sync_log au lieu de l'avaler silencieusement : si le customer
// n'existe pas côté Stripe, les opérations d'abonnement/paiement suivantes
// référenceraient un customer fantôme — divergence d'état non détectée sur un
// flux qui touche l'argent.
async function ensureStripeCustomerTraced(stripe, companyId, flow) {
  try {
    await ensureStripeCustomer(stripe, companyId)
  } catch (e) {
    logSync('stripe', 'webhook', {
      status: 'error',
      error: `ensureStripeCustomer(${flow}) company=${companyId}: ${e.message}`,
    })
  }
}

const router = Router()

// Coerce + JSON-encode helpers, partagés entre les flows by-session et by-token.
const FIELD_COERCERS = {
  is_new_site:        (v) => (v === 'new' || v === 'add_to_existing') ? v : null,
  within_central_controller_range: (v) => typeof v === 'boolean' ? Number(v) : null,
  central_controller_distance: (v) => typeof v === 'string' && v ? v : null,
  needs_wind_sensor:  (v) => typeof v === 'boolean' ? Number(v) : null,
  farm_address:      (v) => v && typeof v === 'object' ? JSON.stringify(v) : null,
  shipping_same_as_farm: (v) => v == null ? null : (v ? 1 : 0),
  shipping_address:   (v) => v && typeof v === 'object' ? JSON.stringify(v) : null,
  network_access:     (v) => typeof v === 'string' ? v : null,
  wifi_ssid:          (v) => v == null ? null : String(v),
  wifi_password:      (v) => v == null ? null : String(v),
  num_greenhouses:    (v) => v == null ? null : Math.max(0, parseInt(v) || 0),
  greenhouses:        (v) => Array.isArray(v) ? JSON.stringify(v) : null,
  extras:             (v) => Array.isArray(v) ? JSON.stringify(v) : null,
  // Réponses aux questions ajoutées par l'utilisateur dans l'éditeur de
  // formulaire — sac clé → valeur, la clé étant l'id de la question.
  custom_answers:     (v) => v && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : null,
}
const FIELD_TO_COLUMN = {
  farm_address:     'farm_address_json',
  shipping_address: 'shipping_address_json',
  greenhouses:      'greenhouses_json',
  extras:           'extras_json',
  custom_answers:   'custom_answers_json',
}

// Construit l'UPDATE partiel à partir d'un body. Retourne { updates, values } prêts à concat.
export function buildPartialUpdate(body) {
  const updates = []
  const values = []
  for (const [key, coerce] of Object.entries(FIELD_COERCERS)) {
    if (key in (body || {})) {
      const column = FIELD_TO_COLUMN[key] || key
      updates.push(`${column}=?`)
      values.push(coerce(body[key]))
    }
  }
  return { updates, values }
}

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
  // Paiement issu d'une soumission (sans facture en attente) : l'entreprise
  // est dans les métadonnées — de la facture, ou de l'abonnement.
  if (!companyId) {
    const subMeta = invoice?.parent?.subscription_details?.metadata || invoice?.subscription_details?.metadata
    companyId = invoice?.metadata?.erp_company_id || subMeta?.erp_company_id || null
    if (companyId && !db.prepare('SELECT 1 FROM companies WHERE id=?').get(companyId)) companyId = null
  }
  const id = newRecordId()
  db.prepare(`
    INSERT INTO customer_onboarding_responses
      (id, stripe_session_id, stripe_invoice_id, pending_invoice_id, company_id, status)
    VALUES (?,?,?,?,?, 'in_progress')
  `).run(id, sessionId, invoice?.id || null, pendingId, companyId)
  return db.prepare('SELECT * FROM customer_onboarding_responses WHERE id=?').get(id)
}

// Total blocks de 4 valves supplémentaires nécessaires d'après les serres.
// Chaque carte chief_grower compte (zones - 4)/4 blocs au-delà de 4 zones.
function computeValveBlocksNeeded(greenhouses) {
  let total = 0
  for (const g of (greenhouses || [])) {
    if (g?.permission_level !== 'chief_grower') continue
    const z = Number(g?.irrigation_zones) || 0
    if (z > 4) total += Math.ceil((z - 4) / 4)
  }
  return total
}

function shapeResponse(row) {
  if (!row) return null
  const greenhouses = row.greenhouses_json ? JSON.parse(row.greenhouses_json) : []
  const valveBlocksNeeded = computeValveBlocksNeeded(greenhouses)
  let valveBlocksPaid = false
  if (row.extras_pending_invoice_id) {
    const pi = db.prepare('SELECT status FROM pending_invoices WHERE id=?').get(row.extras_pending_invoice_id)
    valveBlocksPaid = pi?.status === 'paid'
  }
  return {
    id: row.id,
    status: row.status,
    is_new_site: row.is_new_site,
    within_central_controller_range: row.within_central_controller_range == null ? null : !!row.within_central_controller_range,
    central_controller_distance: row.central_controller_distance || null,
    needs_wind_sensor: row.needs_wind_sensor == null ? null : !!row.needs_wind_sensor,
    farm_address: row.farm_address_json ? JSON.parse(row.farm_address_json) : null,
    shipping_same_as_farm: row.shipping_same_as_farm == null ? null : !!row.shipping_same_as_farm,
    shipping_address: row.shipping_address_json ? JSON.parse(row.shipping_address_json) : null,
    network_access: row.network_access,
    wifi_ssid: row.wifi_ssid,
    wifi_password: row.wifi_password,
    permission_level: row.permission_level,
    form_options: discoveryOptionsFromRow(row),
    num_greenhouses: row.num_greenhouses,
    greenhouses,
    extras: row.extras_json ? JSON.parse(row.extras_json) : [],
    custom_answers: row.custom_answers_json ? JSON.parse(row.custom_answers_json) : {},
    extras_pending_invoice_id: row.extras_pending_invoice_id,
    valve_blocks_needed: valveBlocksNeeded,
    valve_blocks_paid: valveBlocksPaid,
    submitted_at: row.submitted_at,
    // Le client peut revenir sur ses réponses, même envoyées, tant qu'aucune
    // commande n'a été créée à partir du formulaire.
    editable: !row.generated_order_id,
  }
}

const ORDER_LOCKED = 'Une commande a déjà été créée : vos réponses ne peuvent plus être modifiées.'

// Nouvel envoi d'un formulaire déjà soumis : les adresses corrigées sont
// réenregistrées, la date de première soumission reste.
function resubmit(row) {
  db.transaction(() => {
    const claim = db.prepare("UPDATE customer_onboarding_responses SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND generated_order_id IS NULL").run(row.id)
    if (claim.changes !== 1) throw Object.assign(new Error(ORDER_LOCKED), { status: 409 })
    discoveryAddresses(row, { persist: true })
  })()
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
      form_schema: loadSchemaOverrides(),
    })
  } catch (e) {
    if (e.message === 'not_paid') return res.status(402).json({ error: 'Paiement non confirmé' })
    if (e.raw?.code === 'resource_missing') return res.status(404).json({ error: 'Session introuvable' })
    res.status(500).json({ error: e.message })
  }
})

// POST /api/customer/post-payment/:sessionId/confirm-address — même
// confirmation, côté flow Stripe (garde = session payée valide).
router.post('/:sessionId/confirm-address', async (req, res) => {
  try {
    await validateSession(req.params.sessionId)
  } catch {
    return res.status(404).json({ error: 'Session introuvable' })
  }
  res.json(await confirmAddressInput(req.body || {}))
})

// POST /api/customer/post-payment/:sessionId/save — autosave partial state
router.post('/:sessionId/save', async (req, res) => {
  try {
    const { invoice } = await validateSession(req.params.sessionId)
    const row = loadOrInitResponse(req.params.sessionId, invoice)
    if (row.generated_order_id) return res.status(409).json({ error: ORDER_LOCKED })

    const { updates, values } = buildPartialUpdate(req.body)
    if (updates.length === 0) return res.json({ ok: true, saved: 0 })
    updates.push("updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')")
    values.push(row.id)
    db.prepare(`UPDATE customer_onboarding_responses SET ${updates.join(', ')} WHERE id=? AND generated_order_id IS NULL`).run(...values)
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
    if (row.status === 'submitted' && row.generated_order_id) {
      return res.json({ ok: true, already_submitted: true, response: shapeResponse(row) })
    }
    if (!row.is_new_site) return res.status(400).json({ error: 'is_new_site requis avant soumission' })
    // Le contrôleur internet mobile peut venir de la facture : la question de la
    // distance au contrôleur central n'est alors pas posée (voir validation).
    const submitRoles = await detectProductRoles(invoice, getStripeClient())
    const answerErrors = discoveryAnswerErrors(shapeResponse(row), { hasMobileController: submitRoles.includes('mobile_controller') })
    if (answerErrors.length) return res.status(400).json({ error: answerErrors[0], errors: answerErrors })
    if (row.status === 'submitted') {
      resubmit(row)
      return res.json({ ok: true, resubmitted: true, response: shapeResponse(db.prepare('SELECT * FROM customer_onboarding_responses WHERE id=?').get(row.id)) })
    }

    // Finalisation atomique. Endpoint public sans auth = exposé aux double-submits
    // (le client peut renvoyer /submit deux fois, ou deux onglets concurrents).
    // On enveloppe la réclamation du statut ET les upserts d'adresses dans une
    // seule transaction better-sqlite3 :
    //   1. Un UPDATE conditionnel (WHERE status != 'submitted') « réclame » la
    //      soumission de façon atomique. Une seule des requêtes concurrentes voit
    //      changes===1 ; les autres voient changes===0 et n'exécutent aucun upsert.
    //      Cela empêche deux requêtes de voir un SELECT d'adresse vide simultané
    //      puis d'INSÉRER chacune une adresse 'Livraison' en double (orpheline).
    //   2. Les upserts d'adresses tournent dans la même transaction : tout est
    //      commité ensemble, ou rien (rollback si une exception est levée).
    const finalize = db.transaction(() => {
      const claim = db.prepare(
        `UPDATE customer_onboarding_responses SET status='submitted', submitted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status != 'submitted'`
      ).run(row.id)
      if (claim.changes === 0) return { alreadySubmitted: true }

      discoveryAddresses(row, { persist: true })
      return { alreadySubmitted: false }
    })

    const { alreadySubmitted } = finalize()
    const refreshed = db.prepare('SELECT * FROM customer_onboarding_responses WHERE id=?').get(row.id)
    if (alreadySubmitted) {
      return res.json({ ok: true, already_submitted: true, response: shapeResponse(refreshed) })
    }
    res.json({ ok: true, response: shapeResponse(refreshed) })
  } catch (e) {
    if (e.message === 'not_paid') return res.status(402).json({ error: 'Paiement non confirmé' })
    res.status(e.status || 500).json({ error: e.message })
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

    // Resolve company shipping for the new pending_invoice
    const ship = db.prepare(`SELECT province, country FROM adresses WHERE company_id=? AND address_type='Livraison' AND province IS NOT NULL AND province!='' ORDER BY created_at DESC LIMIT 1`).get(row.company_id)
    const formShip = row.shipping_address_json ? JSON.parse(row.shipping_address_json) : null
    const formFarm = row.farm_address_json ? JSON.parse(row.farm_address_json) : null
    const province = ship?.province || formShip?.province || formFarm?.province
    if (!province) return res.status(400).json({ error: 'Aucune province de livraison déterminée — soumettez d\'abord vos adresses' })
    const country = ship?.country || formShip?.country || formFarm?.country || 'Canada'

    // Resolve each role to a product + price
    const resolved = []
    for (const it of items) {
      if (!it?.role || !Number.isFinite(Number(it.qty)) || Number(it.qty) <= 0) continue
      // Le contrôleur Internet mobile a un produit par pays ; repli sur l'ancien
      // rôle unique tant que le catalogue n'a pas les deux.
      const roles = it.role === 'mobile_controller' ? [mobileControllerRole(country), 'mobile_controller'] : [it.role]
      let product = null
      for (const role of roles) {
        product = db.prepare("SELECT id, sku, name_fr, price_cad, monthly_price_cad FROM products WHERE role=? AND active=1 LIMIT 1").get(role)
        if (product) break
      }
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

    // Create pending invoice + lier au formulaire client de façon atomique :
    // si le lien échoue, la facture ne doit pas exister orpheline (impossible à
    // retracer depuis la réponse du client, surtout une fois la Checkout Session créée).
    const id = newRecordId()
    db.transaction(() => {
      db.prepare(`
        INSERT INTO pending_invoices (id, company_id, currency, items_json, shipping_province, shipping_country, due_days, status, created_by)
        VALUES (?,?,?,?,?,?,?,?,?)
      `).run(id, row.company_id, 'CAD', JSON.stringify(resolved), province, country, 30, 'sent', null)

      db.prepare(`UPDATE customer_onboarding_responses SET extras_pending_invoice_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(id, row.id)
    })()

    // Create the Checkout Session immediately so we can redirect right away
    const stripe = getStripeClient()
    const { createOrRefreshCheckoutSession } = await import('../services/stripeInvoices.js')
    const baseUrl = APP_URL
    const pending = db.prepare('SELECT * FROM pending_invoices WHERE id=?').get(id)
    const { url } = await createOrRefreshCheckoutSession({ stripe, pending, baseAppUrl: baseUrl })
    // Make sure the customer has a Stripe customer id
    await ensureStripeCustomerTraced(stripe, row.company_id, 'extras-by-session')

    res.json({ ok: true, pending_invoice_id: id, checkout_url: url, pay_url: `${baseUrl}/erp/pay/${id}` })
  } catch (e) {
    if (e.message === 'not_paid') return res.status(402).json({ error: 'Paiement non confirmé' })
    res.status(500).json({ error: e.message })
  }
})

// ─── Flow by-token (qualification call) ───────────────────────────────────
// Auth = possession du token public court. Pas de validation Stripe (le token
// est créé au moment où l'agent charge la carte avec succès).

function loadByToken(token) {
  const norm = normalizeShortToken(token)
  if (!norm) return null
  return db.prepare('SELECT * FROM customer_onboarding_responses WHERE public_token=?').get(norm)
}

// Pour le flow qualification, les rôles (chief/helper) sont déterminés par
// chaque carte serre pré-créée (permission_level), pas par les line items Stripe.
function detectFromGreenhouses(row) {
  const greenhouses = row.greenhouses_json ? JSON.parse(row.greenhouses_json) : []
  const hasChief = greenhouses.some(g => g.permission_level === 'chief_grower')
  const hasHelper = greenhouses.some(g => g.permission_level === 'helper')
  return {
    has_helper: hasHelper,
    has_chief_grower: hasChief,
    has_mobile_controller: discoveryOptionsFromRow(row).mobile_controller,
    permission_level: hasChief ? 'chief_grower' : hasHelper ? 'helper' : null,
  }
}

// GET /api/customer/post-payment/by-token/:token — payload identique à la
// route by-session, sauf que la source des rôles est greenhouses_json.
router.get('/by-token/:token', (req, res) => {
  const row = loadByToken(req.params.token)
  if (!row) return res.status(404).json({ error: 'Formulaire introuvable' })
  const ctx = loadCompanyContext(row.company_id)
  res.json({
    source: 'qualification',
    session_id: null,
    invoice: null,
    customer_email: null,
    detected: detectFromGreenhouses(row),
    context: ctx,
    response: shapeResponse(row),
    form_schema: loadSchemaOverrides(),
    // Côté front : le nombre de serres est verrouillé (1 carte par Helper/Chief vendu).
    greenhouse_count_locked: true,
  })
})

// POST /api/customer/post-payment/by-token/:token/save — autosave partiel.
router.post('/by-token/:token/save', (req, res) => {
  const row = loadByToken(req.params.token)
  if (!row) return res.status(404).json({ error: 'Formulaire introuvable' })
  if (row.generated_order_id) return res.status(409).json({ error: ORDER_LOCKED })

  const { updates, values } = buildPartialUpdate(req.body)
  if (updates.length === 0) return res.json({ ok: true, saved: 0 })
  updates.push("updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')")
  values.push(row.id)
  db.prepare(`UPDATE customer_onboarding_responses SET ${updates.join(', ')} WHERE id=? AND generated_order_id IS NULL`).run(...values)
  const refreshed = db.prepare('SELECT * FROM customer_onboarding_responses WHERE id=?').get(row.id)
  res.json({ ok: true, response: shapeResponse(refreshed) })
})

// POST /api/customer/post-payment/by-token/:token/confirm-address — confirme
// l'adresse de ferme / de livraison SAISIE par le client, avant qu'elle
// n'entre dans l'ERP. Accès gardé par la possession du token, comme le reste
// du flow ; l'appel sortant vers l'API d'adresses ne part donc pas d'un
// inconnu. Ne persiste rien : le client garde la main sur ce qu'il envoie.
router.post('/by-token/:token/confirm-address', async (req, res) => {
  const row = loadByToken(req.params.token)
  if (!row) return res.status(404).json({ error: 'Formulaire introuvable' })
  res.json(await confirmAddressInput(req.body || {}))
})

// POST /api/customer/post-payment/by-token/:token/submit — finalise et upsert les adresses.
router.post('/by-token/:token/submit', (req, res) => {
  const row = loadByToken(req.params.token)
  if (!row) return res.status(404).json({ error: 'Formulaire introuvable' })
  if (row.status === 'submitted' && row.generated_order_id) {
    return res.json({ ok: true, already_submitted: true, response: shapeResponse(row) })
  }
  if (!row.is_new_site) return res.status(400).json({ error: 'is_new_site requis avant soumission' })
  const answerErrors = discoveryAnswerErrors(shapeResponse(row))
  if (answerErrors.length) return res.status(400).json({ error: answerErrors[0], errors: answerErrors })
  if (row.status === 'submitted') {
    try { resubmit(row) } catch (e) { return res.status(e.status || 500).json({ error: e.message }) }
    return res.json({ ok: true, resubmitted: true, response: shapeResponse(db.prepare('SELECT * FROM customer_onboarding_responses WHERE id=?').get(row.id)) })
  }

  // Les zones supplémentaires seront traitées avec le vendeur après l'envoi.

  db.transaction(() => {
    discoveryAddresses(row, { persist: true })
    db.prepare(`UPDATE customer_onboarding_responses SET status='submitted', submitted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(row.id)
  })()
  const refreshed = db.prepare('SELECT * FROM customer_onboarding_responses WHERE id=?').get(row.id)
  res.json({ ok: true, response: shapeResponse(refreshed) })
})

// Les anciens onglets peuvent encore appeler cette route : aucun nouveau
// paiement de valves n'est proposé dans le formulaire de découverte.
router.post('/by-token/:token/valve-blocks-checkout', (req, res) => {
  const row = loadByToken(req.params.token)
  if (!row) return res.status(404).json({ error: 'Formulaire introuvable' })
  return res.status(410).json({
    error: 'Un vendeur vous contactera pour vos zones d’irrigation supplémentaires. Rechargez le formulaire pour envoyer vos réponses.',
    code: 'valve_blocks_sales_followup',
  })
})

export default router
