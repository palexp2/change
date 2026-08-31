import { Router } from 'express'
import { randomUUID } from 'crypto'
import db from '../db/database.js'
import { getStripeClient, ensureStripeCustomer } from '../services/stripeInvoices.js'
import { normalizeShortToken } from '../utils/shortToken.js'
import { logSync } from '../services/syncLog.js'
import { APP_URL } from '../config/appUrl.js'

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
  farm_address:       (v) => v && typeof v === 'object' ? JSON.stringify(v) : null,
  shipping_same_as_farm: (v) => v == null ? null : (v ? 1 : 0),
  shipping_address:   (v) => v && typeof v === 'object' ? JSON.stringify(v) : null,
  network_access:     (v) => typeof v === 'string' ? v : null,
  wifi_ssid:          (v) => v == null ? null : String(v),
  wifi_password:      (v) => v == null ? null : String(v),
  num_greenhouses:    (v) => v == null ? null : Math.max(0, parseInt(v) || 0),
  greenhouses:        (v) => Array.isArray(v) ? JSON.stringify(v) : null,
  extras:             (v) => Array.isArray(v) ? JSON.stringify(v) : null,
}
const FIELD_TO_COLUMN = {
  farm_address:     'farm_address_json',
  shipping_address: 'shipping_address_json',
  greenhouses:      'greenhouses_json',
  extras:           'extras_json',
}

// Construit l'UPDATE partiel à partir d'un body. Retourne { updates, values } prêts à concat.
function buildPartialUpdate(body) {
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
  const id = randomUUID()
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
    farm_address: row.farm_address_json ? JSON.parse(row.farm_address_json) : null,
    shipping_same_as_farm: row.shipping_same_as_farm == null ? null : !!row.shipping_same_as_farm,
    shipping_address: row.shipping_address_json ? JSON.parse(row.shipping_address_json) : null,
    network_access: row.network_access,
    wifi_ssid: row.wifi_ssid,
    wifi_password: row.wifi_password,
    permission_level: row.permission_level,
    num_greenhouses: row.num_greenhouses,
    greenhouses,
    extras: row.extras_json ? JSON.parse(row.extras_json) : [],
    extras_pending_invoice_id: row.extras_pending_invoice_id,
    valve_blocks_needed: valveBlocksNeeded,
    valve_blocks_paid: valveBlocksPaid,
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
    const { invoice } = await validateSession(req.params.sessionId)
    const row = loadOrInitResponse(req.params.sessionId, invoice)
    if (row.status === 'submitted') return res.status(400).json({ error: 'Déjà soumis' })

    const { updates, values } = buildPartialUpdate(req.body)
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

    // Create pending invoice + lier au formulaire client de façon atomique :
    // si le lien échoue, la facture ne doit pas exister orpheline (impossible à
    // retracer depuis la réponse du client, surtout une fois la Checkout Session créée).
    const id = randomUUID()
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
    has_mobile_controller: false, // qualification ne vend pas le contrôleur mobile
    permission_level: hasChief ? 'chief_grower' : hasHelper ? 'helper' : null,
  }
}

// GET /api/customer/post-payment/by-token/:token — payload identique à la
// route by-session, sauf que la source des rôles est greenhouses_json.
router.get('/by-token/:token', (req, res) => {
  try {
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
      // Côté front : le nombre de serres est verrouillé (1 carte par Helper/Chief vendu).
      greenhouse_count_locked: true,
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/customer/post-payment/by-token/:token/save — autosave partiel.
router.post('/by-token/:token/save', (req, res) => {
  try {
    const row = loadByToken(req.params.token)
    if (!row) return res.status(404).json({ error: 'Formulaire introuvable' })
    if (row.status === 'submitted') return res.status(400).json({ error: 'Déjà soumis' })

    const { updates, values } = buildPartialUpdate(req.body)
    if (updates.length === 0) return res.json({ ok: true, saved: 0 })
    updates.push("updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')")
    values.push(row.id)
    db.prepare(`UPDATE customer_onboarding_responses SET ${updates.join(', ')} WHERE id=?`).run(...values)
    const refreshed = db.prepare('SELECT * FROM customer_onboarding_responses WHERE id=?').get(row.id)
    res.json({ ok: true, response: shapeResponse(refreshed) })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/customer/post-payment/by-token/:token/submit — finalise et upsert les adresses.
router.post('/by-token/:token/submit', (req, res) => {
  try {
    const row = loadByToken(req.params.token)
    if (!row) return res.status(404).json({ error: 'Formulaire introuvable' })
    if (row.status === 'submitted') {
      return res.json({ ok: true, already_submitted: true, response: shapeResponse(row) })
    }
    if (!row.is_new_site) return res.status(400).json({ error: 'is_new_site requis avant soumission' })

    // Si une serre dépasse 4 zones d'irrigation, on exige soit le paiement
    // d'autant de blocs de 4 valves supplémentaires, soit que le client baisse
    // à 4. (L'autre chemin "aviser conseiller" se fait hors-formulaire.)
    const greenhouses = row.greenhouses_json ? JSON.parse(row.greenhouses_json) : []
    const blocksNeeded = computeValveBlocksNeeded(greenhouses)
    if (blocksNeeded > 0) {
      let paid = false
      if (row.extras_pending_invoice_id) {
        const pi = db.prepare('SELECT status FROM pending_invoices WHERE id=?').get(row.extras_pending_invoice_id)
        paid = pi?.status === 'paid'
      }
      if (!paid) {
        return res.status(400).json({
          error: `Vous avez ${blocksNeeded} bloc(s) de 4 valves supplémentaires à payer avant de soumettre. Baissez à 4 zones par serre ou complétez le paiement plus bas dans le formulaire.`,
          code: 'valve_blocks_unpaid',
          valve_blocks_needed: blocksNeeded,
        })
      }
    }

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
    res.status(500).json({ error: e.message })
  }
})

// POST /by-token/:token/valve-blocks-checkout — Stripe Checkout pour les blocs
// de 4 valves d'irrigation supplémentaires (achat unique à 400 $/bloc).
//
// Pourquoi seulement le one-time : modifier l'abonnement Stripe existant pour
// ajouter une ligne 25 $/mois nécessite une intervention sur la subscription
// (prorations, anchor billing, etc.) que le client ne peut pas approuver
// facilement dans Checkout. Pour cette option, on lui demande de contacter
// son conseiller — le frontend affiche le message correspondant.
router.post('/by-token/:token/valve-blocks-checkout', async (req, res) => {
  try {
    const row = loadByToken(req.params.token)
    if (!row) return res.status(404).json({ error: 'Formulaire introuvable' })
    if (row.status === 'submitted') return res.status(400).json({ error: 'Formulaire déjà soumis' })
    if (!row.company_id) return res.status(400).json({ error: 'Aucune entreprise associée' })

    const greenhouses = row.greenhouses_json ? JSON.parse(row.greenhouses_json) : []
    const blocksNeeded = computeValveBlocksNeeded(greenhouses)
    if (blocksNeeded <= 0) {
      return res.status(400).json({ error: 'Aucun bloc supplémentaire requis — toutes vos serres ont ≤ 4 zones' })
    }

    // Si on a déjà un pending_invoice payé pour ce form, refuser (évite les doublons).
    if (row.extras_pending_invoice_id) {
      const existing = db.prepare('SELECT status FROM pending_invoices WHERE id=?').get(row.extras_pending_invoice_id)
      if (existing?.status === 'paid') {
        return res.status(400).json({ error: 'Les blocs supplémentaires ont déjà été payés' })
      }
    }

    const product = db.prepare("SELECT id, sku, name_fr, price_cad FROM products WHERE role='valve_block_onetime' AND active=1 LIMIT 1").get()
    if (!product) return res.status(500).json({ error: 'Produit valve_block_onetime introuvable au catalogue' })
    const unitPrice = Number(product.price_cad || 0)
    if (unitPrice <= 0) return res.status(500).json({ error: 'Prix du bloc de valves non configuré au catalogue' })

    // Résoudre la province/pays pour les taxes (depuis l'adresse de livraison déjà saisie).
    const ship = row.shipping_address_json ? JSON.parse(row.shipping_address_json) : null
    const farm = row.farm_address_json ? JSON.parse(row.farm_address_json) : null
    const province = ship?.province || farm?.province
    const country = ship?.country || farm?.country || 'Canada'
    if (!province) {
      return res.status(400).json({ error: 'Adresse de livraison requise avant le paiement — complétez les sections du haut.' })
    }

    const items = [{
      product_id: product.id,
      qty: blocksNeeded,
      unit_price: unitPrice,
      description: `${blocksNeeded} × ${product.name_fr || 'Bloc 4 valves supplémentaires'}`,
    }]

    // Réutilise extras_pending_invoice_id si présent (et pas encore payé) pour
    // éviter d'empiler des pending_invoices à chaque refresh du Checkout.
    let pendingId = row.extras_pending_invoice_id
    if (pendingId) {
      db.prepare(`
        UPDATE pending_invoices
          SET items_json=?, currency='CAD', shipping_province=?, shipping_country=?,
              status='sent', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id=?
      `).run(JSON.stringify(items), province, country, pendingId)
    } else {
      pendingId = randomUUID()
      db.prepare(`
        INSERT INTO pending_invoices (id, company_id, currency, items_json, shipping_province, shipping_country, due_days, status, created_by)
        VALUES (?,?,?,?,?,?,?,?,?)
      `).run(pendingId, row.company_id, 'CAD', JSON.stringify(items), province, country, 30, 'sent', null)
      db.prepare('UPDATE customer_onboarding_responses SET extras_pending_invoice_id=?, updated_at=strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\') WHERE id=?').run(pendingId, row.id)
    }

    const stripe = getStripeClient()
    const { createOrRefreshCheckoutSession } = await import('../services/stripeInvoices.js')
    const baseUrl = APP_URL
    const pending = db.prepare('SELECT * FROM pending_invoices WHERE id=?').get(pendingId)
    const { url } = await createOrRefreshCheckoutSession({
      stripe,
      pending,
      baseAppUrl: baseUrl,
      successUrl: `${baseUrl}/erp/d/${row.public_token}?paid=1`,
      cancelUrl: `${baseUrl}/erp/d/${row.public_token}?cancelled=1`,
    })
    await ensureStripeCustomerTraced(stripe, row.company_id, 'extras-by-token')

    res.json({
      ok: true,
      pending_invoice_id: pendingId,
      checkout_url: url,
      blocks: blocksNeeded,
      unit_price: unitPrice,
      total: unitPrice * blocksNeeded,
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router
