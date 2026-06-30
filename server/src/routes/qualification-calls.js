import { Router } from 'express'
import { randomUUID } from 'crypto'
import * as postmark from 'postmark'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { getStripeClient, ensureStripeCustomer, getOrCreateTaxRate } from '../services/stripeInvoices.js'
import { computeCanadaTaxes } from '../services/taxes.js'

const router = Router()
router.use(requireAuth)

// Prix mensuels hardcodés des plans (USD/CAD). Doit rester en sync avec
// QUOTE_PRICES du guide d'appel (client/public/qualification-call-guide/index.html).
const PLAN_PRICES = {
  USD: { helper: 130, chief: 220 },
  CAD: { helper: 180, chief: 290 },
}
const PLAN_LABELS = {
  helper: 'Helper',
  chief: 'Chief Grower',
}

// Trouve ou crée un Stripe Product « Helper » / « Chief Grower » et cache son id
// dans connector_config (clé `plan_product_<plan>`). Évite de recréer un product
// à chaque appel.
async function getOrCreatePlanProduct(stripe, plan) {
  const cacheKey = `plan_product_${plan}`
  const existing = db.prepare(
    "SELECT value FROM connector_config WHERE connector='stripe' AND key=?"
  ).get(cacheKey)
  if (existing?.value) return existing.value
  const product = await stripe.products.create({
    name: PLAN_LABELS[plan] || plan,
    metadata: { erp_plan: plan },
  })
  db.prepare(`
    INSERT INTO connector_config (connector, key, value) VALUES ('stripe', ?, ?)
    ON CONFLICT(connector, key) DO UPDATE SET value=excluded.value
  `).run(cacheKey, product.id)
  return product.id
}

// Champs retournés à la fiche entreprise (utilisé par CompanyDetail).
const SELECT_COLS = `
  id, airtable_record_id, company_id, company_name_raw, call_date, status, assignee,
  contact_full_name, contact_email, contact_phone,
  decision_maker_name, decision_maker_role,
  farm_description, has_employees, employees_count, is_charity, can_issue_charity_receipt,
  challenges, challenge_duration, challenge_financial_impact, short_term_goals,
  motivation_today, motivation_why_now, importance_score, readiness_score,
  has_budget, budget_amount, timeline,
  role_in_company, business_models, current_management, management_effective,
  pain_points, grows_tomatoes, tomato_season_months,
  summary, next_steps, notes,
  heard_about, red_flags, created_by,
  quote_currency, quote_helper_count, quote_chief_count,
  quote_paid_at, quote_paid_email, quote_subscription_id,
  system_builder_notes,
  airtable_created_at, created_at, updated_at
`

// Liste de tous les appels de qualification (utilisé par la page /qualification-call).
// Jointure avec companies pour récupérer le nom courant + nombre de pains/red flags
// pré-comptés pour les colonnes de la DataTable.
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT
      q.id, q.airtable_record_id, q.company_id, q.company_name_raw, q.call_date,
      q.status, q.assignee, q.contact_full_name,
      q.farm_description, q.motivation_today, q.heard_about,
      q.summary, q.next_steps,
      q.pain_points, q.red_flags,
      q.quote_paid_at,
      q.airtable_created_at, q.created_at, q.updated_at,
      c.name AS company_name
    FROM qualification_calls q
    LEFT JOIN companies c ON c.id = q.company_id
    ORDER BY COALESCE(q.call_date, q.airtable_created_at, q.created_at) DESC
  `).all()
  // Décode les colonnes JSON et renvoie des counts pour faciliter l'affichage tableau.
  const data = rows.map(r => {
    let pains = []
    let flags = []
    try { if (r.pain_points) pains = JSON.parse(r.pain_points) } catch {}
    try { if (r.red_flags) flags = JSON.parse(r.red_flags) } catch {}
    return {
      ...r,
      pain_points_count: Array.isArray(pains) ? pains.length : 0,
      red_flags_count: Array.isArray(flags) ? flags.length : 0,
      source: r.airtable_record_id && r.airtable_record_id.startsWith('local_') ? 'ERP' : 'Airtable',
    }
  })
  res.json({ data })
})

// Liste des appels de qualification associés à une company.
router.get('/by-company/:companyId', (req, res) => {
  const rows = db.prepare(`
    SELECT ${SELECT_COLS}
    FROM qualification_calls
    WHERE company_id = ?
    ORDER BY COALESCE(call_date, airtable_created_at) DESC
  `).all(req.params.companyId)
  res.json({ data: rows })
})

// Récupère un appel par id.
router.get('/:id', (req, res) => {
  const row = db.prepare(`SELECT ${SELECT_COLS} FROM qualification_calls WHERE id = ?`).get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  res.json(row)
})

// Crée un nouvel appel de qualification rattaché à une company.
router.post('/', (req, res) => {
  const { company_id } = req.body || {}
  if (!company_id) return res.status(400).json({ error: 'company_id requis' })
  const company = db.prepare('SELECT id, name FROM companies WHERE id = ?').get(company_id)
  if (!company) return res.status(404).json({ error: 'Entreprise introuvable' })
  const id = randomUUID()
  // airtable_record_id est UNIQUE NOT NULL — on génère un id local préfixé pour les
  // records créés depuis l'ERP (pas d'origine Airtable).
  const localRecordId = 'local_' + id
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO qualification_calls
      (id, airtable_record_id, company_id, company_name_raw, call_date, status, assignee, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, localRecordId, company.id, company.name, now, 'En cours', req.user.name || null, req.user.id || null, now, now)
  const row = db.prepare(`SELECT ${SELECT_COLS} FROM qualification_calls WHERE id = ?`).get(id)
  res.json(row)
})

// PATCH partiel pour autosave : on whitelist les colonnes éditables côté formulaire.
const EDITABLE_COLS = new Set([
  'contact_full_name', 'contact_email', 'contact_phone',
  'farm_description', 'motivation_today', 'motivation_why_now',
  'heard_about', 'pain_points', 'red_flags',
  'challenges', 'short_term_goals', 'summary', 'next_steps', 'notes',
  'status',
  'quote_currency', 'quote_helper_count', 'quote_chief_count',
  'system_builder_notes',
])

router.patch('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM qualification_calls WHERE id = ?').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })
  const body = req.body || {}
  const sets = []
  const vals = []
  for (const [key, value] of Object.entries(body)) {
    if (!EDITABLE_COLS.has(key)) continue
    sets.push(`${key} = ?`)
    // Colonnes JSON : stocker comme string si on reçoit un tableau.
    if ((key === 'pain_points' || key === 'red_flags') && Array.isArray(value)) {
      vals.push(JSON.stringify(value))
    } else {
      vals.push(value == null ? null : String(value))
    }
  }
  if (!sets.length) return res.json({ ok: true, updated: 0 })
  sets.push(`updated_at = ?`)
  vals.push(new Date().toISOString())
  vals.push(req.params.id)
  db.prepare(`UPDATE qualification_calls SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
  const row = db.prepare(`SELECT ${SELECT_COLS} FROM qualification_calls WHERE id = ?`).get(req.params.id)
  res.json(row)
})

// POST /:id/farm-address — sauvegarde l'adresse de la ferme saisie pendant l'appel.
// Persiste :
//   (a) `companies.address` (string freeform) — pour rester compatible avec le
//       reste de l'app (orders, factures, etc. qui lisent ce champ).
//   (b) Une row dans `adresses` avec address_type='Ferme' pour le company_id de
//       l'appel, contenant les composants structurés (postal_code, province, country)
//       indispensables au calcul de taxes Stripe.
//
// Pattern d'upsert calqué sur server/src/routes/customer-post-payment.js (une seule
// row Ferme par company, on update si elle existe sinon on insert).
//
// Body : { formatted_address?, line1?, city?, province?, postal_code?, country? }
// — tous les champs sont optionnels pour permettre la sauvegarde pendant la frappe
// (validation stricte uniquement au moment du subscribe-card).
// Résout l'adresse de facturation à utiliser pour ce company. On préfère la
// row Facturation (sémantique correcte pour Stripe), à défaut Ferme (saisie
// en slide-0), à défaut Livraison. Renvoie la row trouvée ou null. Utilisé
// par le GET ci-dessous ET par subscribe-card pour la validation.
function resolveBillingAddress(companyId) {
  if (!companyId) return null
  return db.prepare(`
    SELECT line1, city, province, postal_code, country, address_type
      FROM adresses
     WHERE company_id = ?
       AND address_type IN ('Facturation','Ferme','Livraison')
     ORDER BY CASE address_type
                WHEN 'Facturation' THEN 0
                WHEN 'Ferme' THEN 1
                WHEN 'Livraison' THEN 2
                ELSE 3
              END,
              created_at DESC
     LIMIT 1
  `).get(companyId) || null
}

// GET /:id/farm-address — résout l'adresse de facturation (Facturation > Ferme
// > Livraison) du company rattaché à l'appel. Utilisé par l'iframe du guide
// pour pré-remplir les inputs du form de paiement. Le nom de l'endpoint est
// historique (initialement Ferme-only) ; la sémantique est désormais "billing
// address resolver" puisque le form de paiement lit cette valeur.
router.get('/:id/farm-address', (req, res) => {
  const call = db.prepare('SELECT id, company_id FROM qualification_calls WHERE id = ?').get(req.params.id)
  if (!call) return res.status(404).json({ error: 'Appel introuvable' })
  if (!call.company_id) return res.json(null)
  res.json(resolveBillingAddress(call.company_id))
})

// Cible d'upsert selon le contexte : slide-0 capture l'adresse de la ferme,
// le form de paiement gère l'adresse de facturation. On valide strictement.
const UPSERTABLE_ADDRESS_TYPES = new Set(['Ferme', 'Facturation', 'Livraison'])

router.post('/:id/farm-address', (req, res) => {
  const call = db.prepare('SELECT id, company_id FROM qualification_calls WHERE id = ?').get(req.params.id)
  if (!call) return res.status(404).json({ error: 'Appel introuvable' })
  if (!call.company_id) return res.status(400).json({ error: 'Aucune entreprise liée à l\'appel' })

  const {
    formatted_address = null,
    line1 = null,
    city = null,
    province = null,
    postal_code = null,
    country = null,
    address_type = 'Ferme',
  } = req.body || {}

  if (!UPSERTABLE_ADDRESS_TYPES.has(address_type)) {
    return res.status(400).json({ error: `address_type invalide (attendu : ${[...UPSERTABLE_ADDRESS_TYPES].join(', ')})` })
  }

  // Les deux écritures (freeform companies.address + row structurée adresses)
  // doivent être atomiques : si la 2e échoue, l'adresse freeform et l'adresse
  // structurée divergeraient — source d'erreurs de taxes et d'adresse de
  // facturation Stripe incomplète. On les enveloppe dans une transaction.
  const hasStructured = line1 || city || province || postal_code || country
  const upsertAddress = db.transaction(() => {
    // (a) Maj du champ freeform companies.address (utilisé partout dans l'ERP)
    if (formatted_address !== null) {
      db.prepare(`UPDATE companies SET address = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
        .run(formatted_address || null, call.company_id)
    }

    // (b) Upsert de la row structurée pour le type demandé (seulement si on a
    //     au moins un champ structuré)
    if (hasStructured) {
      const existing = db.prepare(
        "SELECT id FROM adresses WHERE company_id=? AND address_type=? ORDER BY created_at DESC LIMIT 1"
      ).get(call.company_id, address_type)
      if (existing) {
        db.prepare(`
          UPDATE adresses
             SET line1 = ?, city = ?, province = ?, postal_code = ?, country = ?,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE id = ?
        `).run(line1 || null, city || null, province || null, postal_code || null, country || null, existing.id)
      } else {
        db.prepare(`
          INSERT INTO adresses (id, company_id, address_type, line1, city, province, postal_code, country)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(randomUUID(), call.company_id, address_type, line1 || null, city || null, province || null, postal_code || null, country || null)
      }
    }
  })
  upsertAddress()

  res.json({ ok: true })
})

// POST /:id/subscribe-card — crée un abonnement Stripe à partir d'un PaymentMethod
// déjà tokenisé côté client (Stripe Elements). Helper×N + Chief×M selon le quote,
// price_data ad-hoc avec PLAN_PRICES, premier paiement immédiat.
// Renvoie { status, subscription_id, client_secret? } — si client_secret présent,
// le front doit appeler stripe.confirmCardPayment(client_secret) pour 3DS.
router.post('/:id/subscribe-card', async (req, res) => {
  const call = db.prepare('SELECT id, company_id FROM qualification_calls WHERE id = ?').get(req.params.id)
  if (!call) return res.status(404).json({ error: 'Appel introuvable' })
  if (!call.company_id) return res.status(400).json({ error: 'Aucune entreprise liée à l\'appel' })

  const {
    payment_method_id,
    helper = 0,
    chief = 0,
    currency = 'USD',
    email,
    name,
    discount,
    farm_address,
  } = req.body || {}
  if (!payment_method_id || typeof payment_method_id !== 'string') {
    return res.status(400).json({ error: 'payment_method_id requis' })
  }

  // Si le client envoie l'adresse de facturation en payload (depuis les inputs
  // visibles du form de paiement), elle écrase la row Facturation persistée.
  // Évite une course entre l'autosave on-blur et la création de la subscription
  // — ce qui est dans le payload EST autoritaire. On écrit dans 'Facturation'
  // car c'est sémantiquement ce que le form représente.
  if (farm_address && typeof farm_address === 'object') {
    const fa = farm_address
    const line1 = typeof fa.line1 === 'string' ? fa.line1.trim() : ''
    const city = typeof fa.city === 'string' ? fa.city.trim() : ''
    const province = typeof fa.province === 'string' ? fa.province.trim().toUpperCase() : ''
    const postal_code = typeof fa.postal_code === 'string' ? fa.postal_code.trim() : ''
    const country = typeof fa.country === 'string' ? fa.country.trim().toUpperCase() : ''
    if (postal_code && province && country) {
      // Upsert atomique : le SELECT-puis-UPDATE/INSERT forme une seule unité,
      // pour que la row Facturation structurée reste cohérente (taxes + adresse
      // de facturation Stripe) même si une écriture intermédiaire échoue.
      const upsertBilling = db.transaction(() => {
        const existing = db.prepare(
          "SELECT id FROM adresses WHERE company_id=? AND address_type='Facturation' ORDER BY created_at DESC LIMIT 1"
        ).get(call.company_id)
        if (existing) {
          db.prepare(`UPDATE adresses SET line1=?, city=?, province=?, postal_code=?, country=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
            .run(line1 || null, city || null, province, postal_code, country, existing.id)
        } else {
          db.prepare(`INSERT INTO adresses (id, company_id, address_type, line1, city, province, postal_code, country) VALUES (?, ?, 'Facturation', ?, ?, ?, ?, ?)`)
            .run(randomUUID(), call.company_id, line1 || null, city || null, province, postal_code, country)
        }
      })
      upsertBilling()
    }
  }
  const curr = String(currency).toUpperCase()
  if (curr !== 'USD' && curr !== 'CAD') {
    return res.status(400).json({ error: 'Devise invalide (USD/CAD)' })
  }
  const h = Number(helper) || 0
  const c = Number(chief) || 0
  if (h <= 0 && c <= 0) {
    return res.status(400).json({ error: 'Au moins un Helper ou un Chief Grower est requis' })
  }

  // Validation du discount ad-hoc (optionnel). Le vendeur définit le pourcentage
  // ou le montant fixe + la durée — on crée un coupon Stripe à la volée et on
  // l'attache à la subscription.
  let couponSpec = null
  if (discount && typeof discount === 'object') {
    const dType = String(discount.type || '').toLowerCase()
    const dValue = Number(discount.value)
    const dDuration = String(discount.duration || '').toLowerCase()
    if (dType !== 'percent' && dType !== 'amount') {
      return res.status(400).json({ error: 'discount.type doit être "percent" ou "amount"' })
    }
    if (!Number.isFinite(dValue) || dValue <= 0) {
      return res.status(400).json({ error: 'discount.value doit être > 0' })
    }
    if (dType === 'percent' && dValue > 100) {
      return res.status(400).json({ error: 'discount.value (%) doit être ≤ 100' })
    }
    if (!['once', 'repeating', 'forever'].includes(dDuration)) {
      return res.status(400).json({ error: 'discount.duration doit être once / repeating / forever' })
    }
    couponSpec = {
      type: dType,
      value: dValue,
      duration: dDuration,
    }
    if (dDuration === 'repeating') {
      const months = Number(discount.months)
      if (!Number.isInteger(months) || months < 1 || months > 60) {
        return res.status(400).json({ error: 'discount.months doit être un entier entre 1 et 60 pour repeating' })
      }
      couponSpec.months = months
    }
  }

  // Adresse de facturation : priorité Facturation > Ferme > Livraison. Bloquant
  // si manquante — Stripe a besoin du country + postal_code pour les receipts
  // et pour matcher les tax_rates qu'on attache.
  const farmAddress = resolveBillingAddress(call.company_id)
  if (!farmAddress || !farmAddress.country || !farmAddress.postal_code || !farmAddress.province) {
    return res.status(400).json({
      error: 'Adresse de la ferme incomplète. Sélectionnez l\'adresse via la recherche pour récupérer code postal, province et pays.',
    })
  }

  let stripe
  try { stripe = getStripeClient() }
  catch (e) { return res.status(503).json({ error: e.message }) }

  try {
    // 1. Customer Stripe (créé si absent)
    const customerId = await ensureStripeCustomer(stripe, call.company_id)

    // 2. Mettre à jour email/name/address du customer. Address obligatoire pour
    //    que Stripe affiche une adresse de facturation sur les receipts et pour
    //    matcher les tax_rates qu'on attache aux items.
    const customerUpdate = {
      address: {
        line1: farmAddress.line1 || undefined,
        city: farmAddress.city || undefined,
        state: farmAddress.province,
        postal_code: farmAddress.postal_code,
        country: farmAddress.country,
      },
    }
    if (email && typeof email === 'string') customerUpdate.email = email
    if (name && typeof name === 'string') customerUpdate.name = name
    await stripe.customers.update(customerId, customerUpdate)

    // 3. Attacher le PaymentMethod (idempotent : ignore si déjà attaché)
    try {
      await stripe.paymentMethods.attach(payment_method_id, { customer: customerId })
    } catch (e) {
      // Si déjà attaché à ce customer, Stripe renvoie une erreur ignorable.
      if (!/already been attached/i.test(e.message || '')) throw e
    }
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: payment_method_id },
    })

    // 4. Tax rates canadiens : à partir de la province + pays de l'adresse Ferme.
    //    computeCanadaTaxes renvoie [] si pays != CA ou province non reconnue —
    //    dans ce cas on laisse la subscription se créer sans tax_rate (comme le
    //    flow Checkout existant). On crée/récupère chaque taxRate via le cache
    //    Stripe partagé avec stripeInvoices.js.
    const taxes = computeCanadaTaxes({
      province: farmAddress.province,
      country: farmAddress.country,
      subtotal: 0, // pour récupérer la liste des taxes applicables, le montant n'importe pas
    })
    const taxRateIds = []
    for (const t of taxes) {
      const id = await getOrCreateTaxRate(stripe, { name: t.name, percentage: t.percentage, jurisdiction: t.jurisdiction })
      taxRateIds.push(id)
    }

    // 5. Items : price_data ad-hoc par plan, quantité = N. tax_rates attachés
    //    par item (même liste pour tous) — Stripe les applique au calcul de
    //    chaque facture récurrente.
    const items = []
    const stripeCurrency = curr.toLowerCase()
    const itemTax = taxRateIds.length > 0 ? { tax_rates: taxRateIds } : {}
    if (h > 0) {
      const productId = await getOrCreatePlanProduct(stripe, 'helper')
      items.push({
        quantity: h,
        price_data: {
          currency: stripeCurrency,
          product: productId,
          unit_amount: PLAN_PRICES[curr].helper * 100,
          recurring: { interval: 'month' },
        },
        ...itemTax,
      })
    }
    if (c > 0) {
      const productId = await getOrCreatePlanProduct(stripe, 'chief')
      items.push({
        quantity: c,
        price_data: {
          currency: stripeCurrency,
          product: productId,
          unit_amount: PLAN_PRICES[curr].chief * 100,
          recurring: { interval: 'month' },
        },
        ...itemTax,
      })
    }

    // 6. Coupon ad-hoc si rabais demandé. Stripe permet de créer un coupon
    //    « éphémère » et de l'attacher à la subscription. On ne le cache pas —
    //    chaque vente a son propre coupon, identifiable par sa metadata.
    let couponId = null
    if (couponSpec) {
      const couponParams = {
        duration: couponSpec.duration,
        metadata: {
          erp_qualification_call_id: call.id,
          erp_company_id: call.company_id,
          created_by: 'qualification-call-subscribe-card',
        },
      }
      if (couponSpec.duration === 'repeating') {
        couponParams.duration_in_months = couponSpec.months
      }
      if (couponSpec.type === 'percent') {
        couponParams.percent_off = couponSpec.value
        couponParams.name = `${couponSpec.value}% off${couponSpec.duration === 'once' ? ' (one-time)'
          : couponSpec.duration === 'repeating' ? ` (${couponSpec.months} mo)` : ' (forever)'}`
      } else {
        couponParams.amount_off = Math.round(couponSpec.value * 100)
        couponParams.currency = stripeCurrency
        couponParams.name = `$${couponSpec.value} off${couponSpec.duration === 'once' ? ' (one-time)'
          : couponSpec.duration === 'repeating' ? ` (${couponSpec.months} mo)` : ' (forever)'}`
      }
      const coupon = await stripe.coupons.create(couponParams)
      couponId = coupon.id
    }

    // 7. Création de l'abonnement (facturation immédiate, 3DS géré côté client
    //    via client_secret du PaymentIntent de la première facture).
    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items,
      default_payment_method: payment_method_id,
      payment_behavior: 'default_incomplete',
      payment_settings: { save_default_payment_method: 'on_subscription' },
      ...(couponId ? { discounts: [{ coupon: couponId }] } : {}),
      expand: ['latest_invoice.payment_intent'],
      metadata: {
        erp_qualification_call_id: call.id,
        erp_company_id: call.company_id,
      },
    })

    const pi = subscription.latest_invoice?.payment_intent
    // Si Stripe a confirmé le paiement immédiatement (pas de 3DS), on persiste le
    // flag « payé » sur l'appel. Pour les cas 3DS (requires_action), la confirmation
    // se fait côté client après stripe.confirmCardPayment — non géré ici.
    const isPaid = subscription.status === 'active'
      || subscription.status === 'trialing'
      || pi?.status === 'succeeded'
    let paidAt = null
    let paidEmail = null
    if (isPaid) {
      paidAt = new Date().toISOString()
      paidEmail = (email && typeof email === 'string') ? email : null
      db.prepare(`
        UPDATE qualification_calls
        SET quote_paid_at = ?, quote_paid_email = ?, quote_subscription_id = ?, updated_at = ?
        WHERE id = ?
      `).run(paidAt, paidEmail, subscription.id, paidAt, call.id)
    }
    return res.json({
      status: subscription.status, // active | incomplete | trialing | ...
      subscription_id: subscription.id,
      payment_intent_status: pi?.status || null,
      client_secret: pi?.client_secret || null,
      paid_at: paidAt,
      paid_email: paidEmail,
    })
  } catch (e) {
    console.error('subscribe-card error:', e.message)
    return res.status(400).json({ error: e.message || 'Échec du paiement' })
  }
})

// POST /:id/send-system-builder-email — envoie au client un email (Postmark,
// expéditeur info@orisha.io) contenant le lien System Builder pré-rempli généré
// dans l'onglet System builder du guide d'appel. Side effect : l'UI affiche une
// confirmation listant le destinataire avant d'appeler cette route.
function escapeHtmlText(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function escapeHtmlAttr(s) {
  return escapeHtmlText(s).replace(/"/g, '&quot;')
}
function buildSystemBuilderEmailHtml({ firstName, url }) {
  const greeting = firstName ? `Hey ${escapeHtmlText(firstName)},` : 'Hey there,'
  const href = escapeHtmlAttr(url)
  return `<!DOCTYPE html>
<html>
  <head><meta charset="utf-8"><title>System Builder</title></head>
  <body style="margin: 0; padding: 0; background-color: #f4f4f4; font-family: Arial, sans-serif;">
    <table width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color: #f4f4f4;">
      <tr>
        <td align="center">
          <table width="600" border="0" cellspacing="0" cellpadding="0" style="background-color: #ffffff; border-radius: 4px; overflow: hidden;">
            <tr>
              <td align="center" style="padding: 20px; background-color: #ffffff;">
                <img src="https://orisha.us-east-1.linodeobjects.com/logo.png" alt="Logo Orisha" style="max-width: 150px; display: block;">
              </td>
            </tr>
            <tr><td style="background-color: #22b14c; height: 5px; line-height: 5px; font-size: 0;"></td></tr>
            <tr>
              <td style="padding: 20px;">
                <p style="margin: 0 0 10px 0; font-size: 16px; color: #333333;">${greeting}</p>
                <br>
                <p style="margin: 0 0 20px 0; font-size: 16px; color: #333333;">
                  This is the <a href="${href}">link to your System Builder</a>. We need this information to send equipment to your farm.
                </p>
                <br>
              </td>
            </tr>
            <tr>
              <td style="padding: 20px; text-align: center;">
                <p style="margin: center; font-size: 16px; color: #333333;"><a href="https://www.orisha.io/contact">Need help?</a></p>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding: 20px; background-color: #f4f4f4; font-size: 12px; color: #777777;">
                Automatisation Orisha Inc. 1535 ch. Ste-Foy Bureau 220 Québec, QC G1S 2P1
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`
}
router.post('/:id/send-system-builder-email', async (req, res) => {
  const call = db.prepare('SELECT id FROM qualification_calls WHERE id = ?').get(req.params.id)
  if (!call) return res.status(404).json({ error: 'Appel introuvable' })
  const { email, link, first_name } = req.body || {}
  const to = (email || '').trim()
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
    return res.status(400).json({ error: 'Adresse email destinataire invalide' })
  }
  const url = (link || '').trim()
  if (!/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'Lien System Builder invalide' })
  }
  const token = process.env.POSTMARK_API_KEY
  if (!token) return res.status(500).json({ error: 'POSTMARK_API_KEY manquant' })
  try {
    const client = new postmark.ServerClient(token)
    await client.sendEmail({
      From: 'info@orisha.io',
      To: to,
      Bcc: '5156324@bcc.hubspot.com',
      Subject: 'Last step before we send your Orisha',
      HtmlBody: buildSystemBuilderEmailHtml({ firstName: (first_name || '').trim(), url }),
    })
    res.json({ ok: true })
  } catch (e) {
    res.status(502).json({ error: e.message || 'Échec de l\'envoi de l\'email' })
  }
})

// Suppression — utilisée pour nettoyer un record créé par erreur depuis l'ERP.
// Les records importés d'Airtable (airtable_record_id sans préfixe `local_`) sont
// protégés : la sync Airtable les recréerait, et leur autorité reste là-bas.
router.delete('/:id', (req, res) => {
  const row = db.prepare('SELECT airtable_record_id FROM qualification_calls WHERE id = ?').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  if (!row.airtable_record_id || !row.airtable_record_id.startsWith('local_')) {
    return res.status(403).json({ error: 'Suppression interdite : ce record provient d\'Airtable. À supprimer depuis Airtable.' })
  }
  db.prepare('DELETE FROM qualification_calls WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
})

export default router
