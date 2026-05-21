import { Router } from 'express'
import { randomUUID } from 'crypto'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { getStripeClient, ensureStripeCustomer } from '../services/stripeInvoices.js'

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
  } = req.body || {}
  if (!payment_method_id || typeof payment_method_id !== 'string') {
    return res.status(400).json({ error: 'payment_method_id requis' })
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

  let stripe
  try { stripe = getStripeClient() }
  catch (e) { return res.status(503).json({ error: e.message }) }

  try {
    // 1. Customer Stripe (créé si absent)
    const customerId = await ensureStripeCustomer(stripe, call.company_id)

    // 2. Mettre à jour email/name du customer si fournis (utile quand le call est
    //    en cours de qualification et que ces infos viennent d'être saisies).
    const customerUpdate = {}
    if (email && typeof email === 'string') customerUpdate.email = email
    if (name && typeof name === 'string') customerUpdate.name = name
    if (Object.keys(customerUpdate).length) {
      await stripe.customers.update(customerId, customerUpdate)
    }

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

    // 4. Items : price_data ad-hoc par plan, quantité = N
    const items = []
    const stripeCurrency = curr.toLowerCase()
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
      })
    }

    // 5. Coupon ad-hoc si rabais demandé. Stripe permet de créer un coupon
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

    // 6. Création de l'abonnement (facturation immédiate, 3DS géré côté client
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
