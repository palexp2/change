import { Router } from 'express'
import { newRecordId } from '../utils/recordId.js'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import {
  getStripeClient,
  ensureStripeCustomer,
  getOrCreateTaxRate,
} from '../services/stripeInvoices.js'
import { computeCanadaTaxes } from '../services/taxes.js'
import { computeMonthlyNet } from '../services/subscriptionMonthly.js'
import { resolveStripeSubscriptionFields } from '../services/stripeSubscriptionFieldMap.js'
import {
  extractItemsFromStripeSub,
  setCurrentItemsSnapshot,
} from '../services/subscriptionItemsSnapshot.js'
import { isStripeConfigured, mapStatus } from '../services/stripe.js'
import { emitEntity } from '../services/realtimeEmitters.js'
import { checkForeignKeys } from '../utils/fkExists.js'
import { logSync } from '../services/syncLog.js'

const router = Router()
router.use(requireAuth)

const INTERVALS = ['month', 'year']
const CURRENCIES = ['CAD', 'USD']
const COLLECTION_METHODS = ['charge_automatically', 'send_invoice']

// Un item de subscription Stripe exige un *produit* Stripe existant : contrairement
// aux Checkout Sessions, `price_data` n'accepte pas de `product_data` inline. On
// crée donc (une seule fois) un produit Stripe par produit ERP — ou par libellé
// pour les lignes custom — et on cache l'id dans connector_config, comme les
// tax_rates (cf. getOrCreateTaxRate).
async function getOrCreateStripeProduct(stripe, { erpProductId, name }) {
  const cacheKey = erpProductId
    ? `sub_product_erp_${erpProductId}`
    : `sub_product_label_${name.toLowerCase().slice(0, 120)}`
  const existing = db.prepare(
    "SELECT value FROM connector_config WHERE connector='stripe' AND key=?"
  ).get(cacheKey)
  if (existing?.value) {
    // Le produit peut avoir été supprimé côté Stripe : on retombe sur une
    // création plutôt que de laisser l'abonnement échouer sur un id fantôme.
    try {
      const p = await stripe.products.retrieve(existing.value)
      if (p && !p.deleted) return p.id
    } catch { /* recrée ci-dessous */ }
  }
  const created = await stripe.products.create({
    name: name.slice(0, 250),
    ...(erpProductId ? { metadata: { erp_product_id: erpProductId } } : {}),
  })
  db.prepare(`
    INSERT INTO connector_config (connector, key, value) VALUES ('stripe', ?, ?)
    ON CONFLICT(connector, key) DO UPDATE SET value=excluded.value
  `).run(cacheKey, created.id)
  return created.id
}

function cardLabel(pm) {
  if (pm.type === 'card' && pm.card) {
    return `${pm.card.brand?.toUpperCase() || 'Carte'} •••• ${pm.card.last4} (exp. ${String(pm.card.exp_month).padStart(2, '0')}/${pm.card.exp_year})`
  }
  return pm.type
}

// GET /api/stripe-subscriptions/companies/:companyId/billing-context
// De quoi laisser l'UI choisir un mode de facturation valide AVANT toute écriture
// dans Stripe : client Stripe déjà lié ?, courriel de facturation connu ?, cartes
// enregistrées ?
router.get('/companies/:companyId/billing-context', async (req, res) => {
  const co = db.prepare(
    'SELECT id, name, email, stripe_customer_id FROM companies WHERE id=? AND deleted_at IS NULL'
  ).get(req.params.companyId)
  if (!co) return res.status(404).json({ error: 'Entreprise introuvable' })

  // Même résolution que ensureStripeCustomer : courriel de l'entreprise, sinon
  // celui du premier contact.
  let email = co.email
  if (!email) {
    email = db.prepare(
      "SELECT email FROM contacts WHERE company_id=? AND email IS NOT NULL AND email!='' ORDER BY created_at LIMIT 1"
    ).get(co.id)?.email || null
  }

  if (!isStripeConfigured()) {
    return res.json({ stripe_configured: false, customer_id: null, email, payment_methods: [] })
  }

  let paymentMethods = []
  let stripeEmail = null
  if (co.stripe_customer_id) {
    try {
      const stripe = getStripeClient()
      const customer = await stripe.customers.retrieve(co.stripe_customer_id)
      stripeEmail = customer?.deleted ? null : (customer?.email || null)
      const defaultPm = customer?.invoice_settings?.default_payment_method || null
      const list = await stripe.paymentMethods.list({ customer: co.stripe_customer_id, type: 'card', limit: 10 })
      paymentMethods = (list.data || []).map(pm => ({
        id: pm.id,
        label: cardLabel(pm),
        is_default: pm.id === defaultPm,
      }))
    } catch (e) {
      // Stripe injoignable / customer supprimé : on ne bloque pas l'ouverture de
      // la modale, l'UI se rabat sur la facturation par courriel.
      console.warn('[stripe-subscriptions] billing-context:', e.message)
    }
  }

  res.json({
    stripe_configured: true,
    customer_id: co.stripe_customer_id || null,
    email: stripeEmail || email,
    payment_methods: paymentMethods,
  })
})

// POST /api/stripe-subscriptions — crée un abonnement récurrent dans Stripe pour
// une entreprise, puis le reflète immédiatement dans la table `subscriptions`.
//
// Le *mouvement* MRR (subscription_events) n'est volontairement PAS écrit ici :
// c'est le webhook customer.subscription.created qui l'enregistre, et lui seul,
// sinon la création apparaîtrait deux fois dans les mouvements d'abonnements.
router.post('/', async (req, res) => {
  const started = Date.now()
  const {
    company_id, items, interval = 'month', interval_count = 1,
    currency = 'CAD', collection_method = 'send_invoice',
    days_until_due = 30, trial_days = 0,
    payment_method_id, shipping_province, shipping_country,
  } = req.body || {}

  if (!company_id) return res.status(400).json({ error: 'company_id requis' })
  const fkErr = checkForeignKeys({ company_id })
  if (fkErr) return res.status(400).json({ error: fkErr.message })
  if (!shipping_province) {
    return res.status(400).json({
      error: "Aucune adresse de livraison avec province trouvée pour cette entreprise. Créez une adresse de livraison avant de créer un abonnement (elle détermine les taxes).",
      code: 'no_shipping_province',
    })
  }
  if (!INTERVALS.includes(interval)) return res.status(400).json({ error: 'interval doit être month ou year' })
  const count = Math.floor(Number(interval_count) || 1)
  const maxCount = interval === 'month' ? 12 : 1
  if (!Number.isFinite(count) || count < 1 || count > maxCount) {
    return res.status(400).json({ error: `interval_count doit être entre 1 et ${maxCount} pour un intervalle ${interval}` })
  }
  const curr = String(currency).toUpperCase()
  if (!CURRENCIES.includes(curr)) return res.status(400).json({ error: 'currency doit être CAD ou USD' })
  if (!COLLECTION_METHODS.includes(collection_method)) {
    return res.status(400).json({ error: 'collection_method invalide' })
  }
  const dueDays = Math.floor(Number(days_until_due) || 30)
  if (collection_method === 'send_invoice' && (dueDays < 0 || dueDays > 365)) {
    return res.status(400).json({ error: 'days_until_due doit être entre 0 et 365' })
  }
  const trial = Math.floor(Number(trial_days) || 0)
  if (trial < 0 || trial > 730) return res.status(400).json({ error: 'trial_days doit être entre 0 et 730' })

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Au moins une ligne est requise' })
  }
  const cleanItems = []
  for (const it of items) {
    const qty = Math.floor(Number(it.qty))
    const unitPrice = Number(it.unit_price)
    if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: 'qty invalide (entier > 0)' })
    if (!Number.isFinite(unitPrice) || unitPrice < 0) return res.status(400).json({ error: 'unit_price invalide' })
    const description = String(it.description || '').trim()
    if (!description) return res.status(400).json({ error: 'Chaque ligne doit avoir une description' })
    cleanItems.push({ product_id: it.product_id || null, qty, unit_price: unitPrice, description })
  }

  if (!isStripeConfigured()) return res.status(503).json({ error: 'Stripe non configuré' })

  try {
    const stripe = getStripeClient()
    const customerId = await ensureStripeCustomer(stripe, company_id)

    if (collection_method === 'charge_automatically' && !payment_method_id) {
      return res.status(400).json({ error: 'Aucune carte sélectionnée pour le prélèvement automatique' })
    }
    if (collection_method === 'send_invoice') {
      const customer = await stripe.customers.retrieve(customerId)
      if (!customer || customer.deleted || !customer.email) {
        return res.status(400).json({
          error: "Stripe ne peut pas envoyer de facture : aucun courriel n'est associé au client. Ajoutez un courriel à l'entreprise ou à un de ses contacts.",
          code: 'no_customer_email',
        })
      }
    }

    // Taxes : mêmes règles que les factures (province + pays de l'adresse de
    // livraison). Hors Canada, computeCanadaTaxes renvoie [] → aucun tax_rate.
    const taxes = computeCanadaTaxes({
      province: shipping_province,
      country: shipping_country || 'Canada',
      subtotal: 0,
    })
    const taxRateIds = []
    for (const t of taxes) {
      taxRateIds.push(await getOrCreateTaxRate(stripe, { name: t.name, percentage: t.percentage, jurisdiction: t.jurisdiction }))
    }
    const itemTax = taxRateIds.length > 0 ? { tax_rates: taxRateIds } : {}

    const stripeItems = []
    for (const it of cleanItems) {
      const productId = await getOrCreateStripeProduct(stripe, { erpProductId: it.product_id, name: it.description })
      stripeItems.push({
        quantity: it.qty,
        price_data: {
          currency: curr.toLowerCase(),
          product: productId,
          unit_amount: Math.round(it.unit_price * 100),
          recurring: { interval, interval_count: count },
        },
        ...itemTax,
      })
    }

    const sub = await stripe.subscriptions.create({
      customer: customerId,
      items: stripeItems,
      collection_method,
      ...(collection_method === 'send_invoice'
        ? { days_until_due: dueDays }
        : { default_payment_method: payment_method_id }),
      ...(trial > 0 ? { trial_period_days: trial } : {}),
      metadata: {
        erp_company_id: company_id,
        created_via: 'erp-company-page',
        created_by: req.user?.id || '',
      },
      expand: ['latest_invoice', 'items.data.price'],
    })

    // Miroir immédiat dans l'ERP : sans ça l'abonnement n'apparaîtrait qu'à
    // l'arrivée du webhook. Le webhook fera ensuite l'UPDATE + l'event de
    // création (voir commentaire d'en-tête).
    const localId = upsertLocalSubscription({ sub, companyId: company_id, customerId, userId: req.user?.id })

    logSync('stripe-subscription', 'manual', {
      status: 'success',
      modified: 1,
      durationMs: Date.now() - started,
    })

    res.json({
      ok: true,
      subscription_id: sub.id,
      erp_subscription_id: localId,
      status: sub.status,
      stripe_url: `https://dashboard.stripe.com/subscriptions/${sub.id}`,
      hosted_invoice_url: sub.latest_invoice?.hosted_invoice_url || null,
      duration_ms: Date.now() - started,
    })
  } catch (e) {
    // Création d'abonnement = opération qui touche l'argent : tout échec reste
    // auditable dans sync_log plutôt que de vivre uniquement dans la réponse HTTP.
    logSync('stripe-subscription', 'manual', {
      status: 'error',
      error: `company=${company_id}: ${e.message}`,
      durationMs: Date.now() - started,
    })
    console.error('[stripe-subscriptions] create:', e.message)
    res.status(400).json({ error: e.message })
  }
})

// Reflète un sub Stripe fraîchement créé dans la table `subscriptions`, avec la
// même normalisation que la sync polling et le webhook (montant net, dates
// configurables, snapshot d'items). Retourne l'id ERP.
function upsertLocalSubscription({ sub, companyId, customerId, userId }) {
  const { amountMonthly, currency, intervalType } = computeMonthlyNet(sub)
  const status = mapStatus(sub.status)
  const {
    start_date: startDate,
    cancel_date: cancelDate,
    trial_end_date: trialEndDate,
    customer_email: customerEmail,
  } = resolveStripeSubscriptionFields(sub)
  const stripeUrl = `https://dashboard.stripe.com/subscriptions/${sub.id}`
  const intervalCount = sub.items?.data?.[0]?.price?.recurring?.interval_count ?? 1

  const existing = db.prepare('SELECT id FROM subscriptions WHERE stripe_id=?').get(sub.id)
  const id = existing?.id || newRecordId()
  if (existing) {
    db.prepare(`
      UPDATE subscriptions SET
        company_id=COALESCE(?,company_id), status=?, amount_monthly=?, currency=?,
        start_date=?, cancel_date=?, trial_end_date=?, stripe_url=?,
        customer_id=?, customer_email=?, interval_count=?, interval_type=?
      WHERE id=?
    `).run(
      companyId, status, amountMonthly, currency,
      startDate, cancelDate, trialEndDate, stripeUrl,
      customerId, customerEmail, intervalCount, intervalType, id,
    )
  } else {
    db.prepare(`
      INSERT INTO subscriptions (
        id, company_id, stripe_id, status, amount_monthly, currency,
        start_date, cancel_date, trial_end_date, stripe_url, customer_id, customer_email,
        interval_count, interval_type
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id, companyId, sub.id, status, amountMonthly, currency,
      startDate, cancelDate, trialEndDate, stripeUrl, customerId, customerEmail,
      intervalCount, intervalType,
    )
  }
  if (status !== 'canceled') setCurrentItemsSnapshot(id, extractItemsFromStripeSub(sub))

  const row = db.prepare(`
    SELECT s.*, co.name as company_name
    FROM subscriptions s LEFT JOIN companies co ON s.company_id = co.id
    WHERE s.id = ?
  `).get(id)
  emitEntity('subscription', existing ? 'updated' : 'created', id, row, userId)
  return id
}

export default router
