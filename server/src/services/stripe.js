import Stripe from 'stripe'
import { v4 as uuid } from 'uuid'
import db from '../db/database.js'
import { recordEvent, classifyChange } from './subscriptionEvents.js'
import {
  extractItemsFromStripeSub,
  getCurrentItemsSnapshot,
  setCurrentItemsSnapshot,
} from './subscriptionItemsSnapshot.js'
import { computeMonthlyNet } from './subscriptionMonthly.js'
import { resolveStripeSubscriptionFields } from './stripeSubscriptionFieldMap.js'

export function getStripeKey() {
  const row = db.prepare(
    "SELECT value FROM connector_config WHERE connector='stripe' AND key='secret_key'"
  ).get()
  return row?.value || null
}

export function isStripeConfigured() {
  return !!getStripeKey()
}

// Vrai uniquement quand Stripe confirme que le record n'existe pas (404 /
// resource_missing). Un outage transitoire — rate-limit (429), 5xx, coupure
// réseau — ne doit PAS matcher : sinon on traite « API momentanément KO »
// comme « facture absente » et le refund est classé 'unmatched' de façon
// permanente alors que la donnée existe (incohérence comptable silencieuse).
function isStripeResourceMissing(e) {
  return e?.code === 'resource_missing' || e?.statusCode === 404
}

// Fixes refund factures that are missing document_number by resolving the
// original invoice via Stripe API (refund → charge → invoice) and using its
// document_number with a "-R" suffix. Idempotent — skips rows already set.
export async function fixRefundDocumentNumbers({ dryRun = false } = {}) {
  const secretKey = getStripeKey()
  if (!secretKey) throw new Error('Stripe non configuré')
  const stripe = new Stripe(secretKey)

  const rows = db.prepare(`
    SELECT id, invoice_id
    FROM factures
    WHERE status='Remboursement'
      AND sync_source='Remboursements Stripe'
      AND (document_number IS NULL OR document_number='')
      AND invoice_id IS NOT NULL
  `).all()

  let patched = 0
  let unmatched = 0
  let errors = 0
  const details = []

  for (const row of rows) {
    const refundId = row.invoice_id
    try {
      let chargeId = null
      let stripeInvoiceId = null
      let stripeInvoiceNumber = null

      if (refundId.startsWith('re_')) {
        const refund = await stripe.refunds.retrieve(refundId)
        chargeId = typeof refund.charge === 'string' ? refund.charge : refund.charge?.id
      } else if (refundId.startsWith('py_') || refundId.startsWith('pyr_') || refundId.startsWith('ch_')) {
        chargeId = refundId.startsWith('ch_') ? refundId : null
        if (!chargeId) {
          // py_/pyr_ identifiers aren't retrievable as charges directly;
          // fall back to refunds.list filtered by payment_intent if needed.
          // Ne swallow que le « record absent » — toute autre erreur (outage,
          // rate-limit) remonte au catch externe et incrémente `errors`.
          const refund = await stripe.refunds.retrieve(refundId).catch((e) => {
            if (isStripeResourceMissing(e)) return null
            throw e
          })
          if (refund) chargeId = typeof refund.charge === 'string' ? refund.charge : refund.charge?.id
        }
      }

      if (chargeId) {
        const charge = await stripe.charges.retrieve(chargeId)
        stripeInvoiceId = typeof charge.invoice === 'string' ? charge.invoice : charge.invoice?.id
        if (stripeInvoiceId && !charge.invoice?.number) {
          // Idem : une facture réellement absente → null (on retombera sur les
          // fallbacks) ; un outage Stripe doit échouer franc et être compté.
          const inv = await stripe.invoices.retrieve(stripeInvoiceId).catch((e) => {
            if (isStripeResourceMissing(e)) return null
            throw e
          })
          stripeInvoiceNumber = inv?.number || null
        } else {
          stripeInvoiceNumber = charge.invoice?.number || null
        }
      }

      let docNumber = null
      if (stripeInvoiceId) {
        const orig = db.prepare(
          'SELECT document_number FROM factures WHERE invoice_id=? AND document_number IS NOT NULL LIMIT 1'
        ).get(stripeInvoiceId)
        if (orig?.document_number) docNumber = `${orig.document_number}-R`
      }
      if (!docNumber && stripeInvoiceNumber) docNumber = `${stripeInvoiceNumber}-R`

      if (!docNumber) {
        unmatched++
        details.push({ id: row.id, refund_id: refundId, reason: 'no_original_invoice', charge_id: chargeId })
        continue
      }

      if (!dryRun) {
        db.prepare(
          `UPDATE factures SET document_number=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`
        ).run(docNumber, row.id)
      }
      patched++
      details.push({ id: row.id, refund_id: refundId, document_number: docNumber })
    } catch (e) {
      errors++
      details.push({ id: row.id, refund_id: refundId, error: e.message })
    }
  }

  console.log(`✅ Fix refund doc numbers: ${patched} patchés, ${unmatched} sans facture d'origine, ${errors} erreurs sur ${rows.length}`)
  return { total: rows.length, patched, unmatched, errors, details: details.slice(0, 100) }
}

function mapStatus(stripeStatus) {
  const map = {
    active: 'active',
    past_due: 'past_due',
    canceled: 'canceled',
    trialing: 'trialing',
    unpaid: 'past_due',
    incomplete: 'past_due',
    incomplete_expired: 'canceled',
    paused: 'canceled',
  }
  return map[stripeStatus] || 'canceled'
}

export async function syncStripeSubscriptions() {
  const secretKey = getStripeKey()
  if (!secretKey) throw new Error('Stripe non configuré')

  const stripe = new Stripe(secretKey)

  let created = 0
  let updated = 0

  // Collect all subscriptions via auto-paging (actifs + annulés)
  const allSubs = []
  for await (const sub of stripe.subscriptions.list({
    limit: 100,
    expand: ['data.customer', 'data.items.data.price.product', 'data.latest_invoice'],
  })) {
    allSubs.push(sub)
  }
  for await (const sub of stripe.subscriptions.list({
    status: 'canceled',
    limit: 100,
    expand: ['data.customer', 'data.items.data.price.product', 'data.latest_invoice'],
  })) {
    allSubs.push(sub)
  }

  console.log(`🔄 Stripe: ${allSubs.length} abonnement(s) récupérés (actifs + annulés)`)

  for (const sub of allSubs) {
    const customer = sub.customer
    const customerId = typeof customer === 'object' ? customer.id : customer

    // Resolve company — strictement par stripe_customer_id
    let companyId = customerId
      ? db.prepare('SELECT id FROM companies WHERE stripe_customer_id=? LIMIT 1').get(customerId)?.id || null
      : null

    // If no match, keep existing link if updating
    const existingRow = db.prepare(
      "SELECT id, company_id FROM subscriptions WHERE stripe_id=?"
    ).get(sub.id)
    if (!companyId && existingRow?.company_id) companyId = existingRow.company_id

    // Montant mensuel : APRÈS rabais, AVANT taxes — source unique partagée
    // avec le webhook (cf. subscriptionMonthly.js). Sans ce helper, sync polling
    // et webhook divergeaient : la sync utilisait latestInvoice.total (taxes
    // incluses), le webhook sommait items.unit_amount × qty (sans rabais).
    const firstPrice = sub.items?.data?.[0]?.price
    const intervalCount = firstPrice?.recurring?.interval_count ?? 1
    const { amountMonthly, currency, intervalType } = computeMonthlyNet(sub)

    const status = mapStatus(sub.status)
    // Dates + courriel client : champs configurables via la modale « Sync
    // Stripe » de /abonnements (stripeSubscriptionFieldMap.js). Défauts =
    // comportement historique (start_date, canceled_at, trial_end, customer.email).
    const {
      start_date: startDate,
      cancel_date: cancelDate,
      trial_end_date: trialEndDate,
      customer_email: customerEmail,
    } = resolveStripeSubscriptionFields(sub)
    const stripeUrl = `https://dashboard.stripe.com/subscriptions/${sub.id}`

    if (existingRow) {
      const prev = db.prepare('SELECT * FROM subscriptions WHERE id=?').get(existingRow.id)
      const category = classifyChange({
        prevStatus: prev.status, newStatus: status,
        prevAmount: prev.amount_monthly, newAmount: amountMonthly,
      })
      const newItemsSnap = extractItemsFromStripeSub(sub)
      // category=null → changement non significatif (statut active↔past_due
      // sans delta, etc.) : pas d'event mais on persiste quand même l'UPDATE.
      if (category) {
        const eventDate = (category === 'churn' && cancelDate)
          ? new Date(cancelDate).toISOString()
          : new Date().toISOString()
        const itemsBeforeSnap = (category === 'creation') ? [] : (getCurrentItemsSnapshot(existingRow.id) || [])
        const itemsAfterSnap = (category === 'churn') ? [] : newItemsSnap
        await recordEvent({
          subscriptionId: existingRow.id,
          companyId: companyId || prev.company_id,
          eventDate,
          eventType: category,
          category,
          previousAmount: prev.amount_monthly,
          newAmount: amountMonthly,
          currency,
          itemsBefore: itemsBeforeSnap,
          itemsAfter: itemsAfterSnap,
        })
      }
      // Met à jour le miroir avec l'état courant Stripe (sauf si le sub est
      // annulé : on garde le dernier état actif pour pouvoir le réutiliser
      // en cas de réactivation).
      if (status !== 'canceled') {
        setCurrentItemsSnapshot(existingRow.id, newItemsSnap)
      }

      db.prepare(`
        UPDATE subscriptions SET
          company_id=COALESCE(?,company_id),
          status=?, amount_monthly=?, currency=?,
          start_date=?, cancel_date=?, trial_end_date=?,
          stripe_url=?, customer_id=?, customer_email=?,
          interval_count=?, interval_type=?
        WHERE id=?
      `).run(
        companyId, status, amountMonthly, currency,
        startDate, cancelDate, trialEndDate,
        stripeUrl, customerId, customerEmail,
        intervalCount, intervalType,
        existingRow.id
      )
      updated++
    } else {
      const newId = uuid()
      db.prepare(`
        INSERT INTO subscriptions (
          id, company_id, stripe_id, status, amount_monthly, currency,
          start_date, cancel_date, trial_end_date, stripe_url, customer_id, customer_email,
          interval_count, interval_type
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        newId, companyId, sub.id, status, amountMonthly, currency,
        startDate, cancelDate, trialEndDate,
        stripeUrl, customerId, customerEmail,
        intervalCount, intervalType
      )
      // Si le sub arrive déjà annulé (import legacy, sub annulé immédiatement),
      // on n'enregistre aucun event — il n'y a pas de mouvement MRR à tracer.
      // Le sub reste en DB pour l'historique mais n'apparaît pas dans les
      // mouvements d'abonnements.
      const newItemsSnap = extractItemsFromStripeSub(sub)
      if (status !== 'canceled') {
        const eventDate = startDate ? new Date(startDate).toISOString() : new Date().toISOString()
        await recordEvent({
          subscriptionId: newId,
          companyId,
          eventDate,
          eventType: 'creation',
          category: 'creation',
          previousAmount: null,
          newAmount: amountMonthly,
          currency,
          itemsBefore: [],
          itemsAfter: newItemsSnap,
        })
        setCurrentItemsSnapshot(newId, newItemsSnap)
      }
      created++
    }
  }

  console.log(`✅ Stripe sync terminé: ${created} créés, ${updated} mis à jour`)
  return { created, updated, total: allSubs.length }
}

export async function syncStripePayouts({ fullHistory = true } = {}) {
  const secretKey = getStripeKey()
  if (!secretKey) throw new Error('Stripe non configuré')
  const stripe = new Stripe(secretKey)

  let created = 0
  let updated = 0
  let total = 0

  const params = { limit: 100, expand: ['data.destination'] }
  if (!fullHistory) {
    const last = db.prepare('SELECT MAX(created_date) as m FROM stripe_payouts').get()
    if (last?.m) params.created = { gte: Math.floor(new Date(last.m).getTime() / 1000) }
  }

  for await (const p of stripe.payouts.list(params)) {
    total++
    const dest = typeof p.destination === 'object' ? p.destination : null
    const arrival = p.arrival_date ? new Date(p.arrival_date * 1000).toISOString().split('T')[0] : null
    const createdDate = p.created ? new Date(p.created * 1000).toISOString() : null
    const stripeUrl = `https://dashboard.stripe.com/payouts/${p.id}`
    const amount = (p.amount || 0) / 100

    const existing = db.prepare('SELECT id FROM stripe_payouts WHERE stripe_id = ?').get(p.id)
    if (existing) {
      db.prepare(`
        UPDATE stripe_payouts SET
          amount=?, currency=?, status=?, arrival_date=?, created_date=?,
          method=?, type=?, description=?, statement_descriptor=?,
          destination=?, bank_name=?, bank_last4=?,
          failure_code=?, failure_message=?, automatic=?, stripe_url=?, raw=?,
          synced_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id=?
      `).run(
        amount, (p.currency || 'cad').toUpperCase(), p.status, arrival, createdDate,
        p.method, p.type, p.description || null, p.statement_descriptor || null,
        dest?.id || (typeof p.destination === 'string' ? p.destination : null),
        dest?.bank_name || null, dest?.last4 || null,
        p.failure_code || null, p.failure_message || null,
        p.automatic ? 1 : 0, stripeUrl, JSON.stringify(p),
        existing.id
      )
      updated++
    } else {
      db.prepare(`
        INSERT INTO stripe_payouts (
          id, stripe_id, amount, currency, status, arrival_date, created_date,
          method, type, description, statement_descriptor,
          destination, bank_name, bank_last4,
          failure_code, failure_message, automatic, stripe_url, raw
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        uuid(), p.id, amount, (p.currency || 'cad').toUpperCase(), p.status, arrival, createdDate,
        p.method, p.type, p.description || null, p.statement_descriptor || null,
        dest?.id || (typeof p.destination === 'string' ? p.destination : null),
        dest?.bank_name || null, dest?.last4 || null,
        p.failure_code || null, p.failure_message || null,
        p.automatic ? 1 : 0, stripeUrl, JSON.stringify(p)
      )
      created++
    }
  }

  console.log(`✅ Stripe payouts sync: ${created} créés, ${updated} mis à jour (total ${total})`)
  return { created, updated, total }
}

// Parse bt.fee_details to split the fee into processing + TPS + TVQ portions.
// Stripe ventile toujours sa redevance sur les charges via fee_details (type=stripe_fee|tax).
function splitFeeDetails(bt) {
  const details = Array.isArray(bt?.fee_details) ? bt.fee_details : []
  let taxGst = 0
  let taxQst = 0
  for (const d of details) {
    const amt = (d.amount || 0) / 100
    if (d.type === 'tax') {
      const desc = (d.description || '').toLowerCase()
      if (/\b(qst|tvq)\b/.test(desc)) taxQst += amt
      else taxGst += amt
    }
  }
  return { taxGst, taxQst }
}

// Classify a Stripe TaxRate object as GST/TPS or QST/TVQ, or null if unknown.
// Relies on display_name/description (plain text) with a percentage fallback
// (5% → GST, 9.975% → QST). Option 1 per user decision — pas de colonne tax_type
// sur stripe_qb_tax_mapping, on détecte depuis les métadonnées Stripe.
export function classifyTaxRate(tr) {
  if (!tr) return null
  const name = `${tr.display_name || ''} ${tr.description || ''}`.toLowerCase()
  if (/\b(qst|tvq)\b/.test(name)) return 'qst'
  if (/\b(gst|tps|hst|tvh)\b/.test(name)) return 'gst'
  const pct = Number(tr.percentage)
  if (Number.isFinite(pct)) {
    if (Math.abs(pct - 9.975) < 0.1) return 'qst'
    if (Math.abs(pct - 5) < 0.1) return 'gst'
    // TVH mono-taux des provinces harmonisées (ON 13 %, NB/NL/NS/PE 15 %) : Stripe
    // les nomme parfois « Sales tax 13% ON » sans mot-clé HST/TVH. On les classe en
    // 'gst' (taxe fédérale harmonisée, même convention que « HST 13% » plus haut) pour
    // que le montant soit bien soustrait de la ligne HT du Deposit. Sans ça, la taxe
    // n'est pas ventilée et QB la recalcule par-dessus le brut → gros « arrondi taxes ».
    if (Math.abs(pct - 13) < 0.1 || Math.abs(pct - 15) < 0.1) return 'gst'
  }
  return null
}

// Auto-infer a QB TaxCode Id from the combined set of Stripe tax rates applied
// to an invoice. Based on total percentage + province hints. Returns null if
// ambiguous (e.g. 15% HST without state — NB vs NL vs PE).
function autoInferQbTaxCode(taxRates) {
  const valid = taxRates.filter(Boolean)
  if (!valid.length) return null
  const totalPct = Math.round(valid.reduce((s, tr) => s + Number(tr.percentage || 0), 0) * 1000) / 1000
  const states = valid.map(tr => String(tr.state || '').toUpperCase())
  // Well-known Canadian combinations (QB default TaxCode Ids from /query Active=true)
  if (totalPct === 5)      return '5'   // TPS (federal 5%)
  if (totalPct === 13)     return '20'  // TVH ON
  if (totalPct === 14)     return '25'  // TVH N.S. (legacy 14%)
  if (totalPct === 14.975) return '8'   // TPS+TVQ QC combined
  if (totalPct === 9.975)  return '9'   // TVQ QC only
  if (totalPct === 15) {
    if (states.includes('NB')) return '12'  // TVH N.-B. 2016
    if (states.includes('NL')) return '28'  // TVH T.-N.-L. 2016
    if (states.includes('PE')) return '26'  // TVH Î.-P.-É. 2016
  }
  return null
}

// Proratise la taxe d'un remboursement au montant effectivement remboursé.
// Un refund ne porte qu'une fraction de la taxe de la facture d'origine,
// proportionnelle au brut (TTC) remboursé. `fullTax` est la taxe TOTALE de la
// facture (un type : TPS ou TVQ), `refundGross` le brut remboursé (positif, en
// monnaie native), `invoiceGross` le total TTC de la facture d'origine.
// Retourne la taxe (positive) à attribuer au refund pour ce type.
//
// Sans cette proratisation, un refund partiel hérite de 100 % de la taxe de la
// facture (bug : payout po_1TcF3rEO122sMsbJQ1Bl5wao → Deposit 17431, juin 2026 —
// refund 730 $ portait 625,96 $ de taxe au lieu de ~95 $, déversant 610 $ dans la
// ligne « Ajustement d'arrondi taxes »). Cf. computeRefundHt qui proratise déjà le
// HT côté table factures — ici on aligne la taxe stockée sur la même logique.
export function proRateRefundTax(fullTax, refundGross, invoiceGross) {
  if (!fullTax) return 0
  // Pas de total facture fiable → comportement legacy (taxe pleine = refund complet).
  if (!(invoiceGross > 0)) return fullTax
  const ratio = Math.min(1, refundGross / invoiceGross)
  return Math.round(fullTax * ratio * 100) / 100
}

// Code de taxe QB à retenir quand une facture ne porte AUCUNE taxe effective.
// Hors Canada → « Détaxé » (code 4) : exports de biens, services/licences à
// non-résidents, à déclarer à la ligne 101 de la TPS. Pas persisté dans
// stripe_qb_tax_mapping : le même tax_rate peut redevenir non-nul si Orisha
// s'inscrit dans cette juridiction.
// Client canadien sans la moindre taxe → anomalie (taxes jamais facturées, cf.
// facture EA8C6BB7-0003 Ferme Quatre-Temps) : on retourne null pour que
// buildDepositFromPayout lève un warning et bloque le push automatique du payout,
// plutôt que de poster une ligne muette dans les livres.
export function resolveZeroTaxCode({ taxDetails = [], country = null } = {}) {
  if (!taxDetails.every(t => (t.amount || 0) === 0)) return null
  return String(country || '').toUpperCase() === 'CA' ? null : '4'
}

// Pulls all balance_transactions for a payout with source expansion.
// Classifies each charge as subscription vs one-time sale and resolves tax mapping.
export async function syncStripeBalanceTransactions(payoutStripeId) {
  const secretKey = getStripeKey()
  if (!secretKey) throw new Error('Stripe non configuré')
  const stripe = new Stripe(secretKey)

  let created = 0
  let updated = 0

  const taxMap = new Map(
    db.prepare('SELECT stripe_tax_id, qb_tax_code FROM stripe_qb_tax_mapping').all()
      .map(r => [r.stripe_tax_id, r.qb_tax_code])
  )

  // Cache tax rates fetched via stripe.taxRates.retrieve — expand depth (>4) prevents inline expansion.
  const taxRateCache = new Map()
  const getTaxRate = async (id) => {
    if (!id) return null
    if (taxRateCache.has(id)) return taxRateCache.get(id)
    try {
      const tr = await stripe.taxRates.retrieve(id)
      taxRateCache.set(id, tr)
      return tr
    } catch {
      taxRateCache.set(id, null)
      return null
    }
  }

  const params = {
    payout: payoutStripeId,
    limit: 100,
    expand: ['data.source', 'data.source.invoice', 'data.source.customer'],
  }

  // Stripe's newer API no longer populates charge.invoice — look it up via the
  // payment_intent → invoice_payment relationship.
  async function findInvoiceByPaymentIntent(paymentIntentId) {
    if (!paymentIntentId) return null
    try {
      const ipList = await stripe.invoicePayments.list({
        payment: { type: 'payment_intent', payment_intent: paymentIntentId },
        limit: 1,
      })
      const invoiceId = ipList.data?.[0]?.invoice
      if (!invoiceId) return null
      return await stripe.invoices.retrieve(invoiceId)
    } catch {
      return null
    }
  }

  for await (const bt of stripe.balanceTransactions.list(params)) {
    const src = bt.source || {}
    const isCharge = bt.type === 'charge' || bt.type === 'payment'
    const isRefund = bt.type === 'refund' || bt.type === 'payment_refund'

    // Resolve invoice/customer from source
    let invoice = null
    let customer = null
    let paymentIntentId = null
    if (isCharge && src) {
      invoice = typeof src.invoice === 'object' ? src.invoice : null
      customer = typeof src.customer === 'object' ? src.customer : null
      paymentIntentId = src.payment_intent || null
    } else if (isRefund && src?.charge) {
      // For a refund, source.charge may need re-fetching if not expanded
      try {
        const charge = typeof src.charge === 'object' ? src.charge : await stripe.charges.retrieve(src.charge, { expand: ['customer'] })
        invoice = typeof charge.invoice === 'object' ? charge.invoice : null
        customer = typeof charge.customer === 'object' ? charge.customer : null
        paymentIntentId = charge.payment_intent || null
      } catch (e) {
        // Le refund perd son lien charge→facture : il deviendra orphelin sans numéro.
        const chargeId = typeof src.charge === 'string' ? src.charge : src.charge?.id
        console.warn(`⚠️  [stripe] refund ${bt.source_id || bt.id}: échec charges.retrieve(${chargeId}) — lien charge→facture perdu:`, e.message)
      }
    }

    // Fallback: charge.invoice is no longer populated in the newer Stripe API.
    if (!invoice && paymentIntentId) {
      invoice = await findInvoiceByPaymentIntent(paymentIntentId)
    }

    const isSubscription = (invoice?.parent?.subscription_details?.subscription || invoice?.subscription) ? 1 : 0
    const stripeInvoiceId = invoice?.id || null
    const invoiceNumber = invoice?.number || null
    const stripeCustomerId = customer?.id || (typeof src.customer === 'string' ? src.customer : null)
    const customerName = customer?.name || invoice?.customer_name || null

    // Resolve tax code + split invoice taxes per type (TPS/TVQ) using tax_rate metadata.
    // Stripe API 2025-06-30+ renamed total_tax_amounts → total_taxes and moved the
    // tax_rate id under tax_rate_details.tax_rate. Support both shapes.
    let qbTaxCode = null
    const taxDetails = []
    const trObjs = []
    let invoiceTaxGst = 0
    let invoiceTaxQst = 0
    const taxEntries = invoice?.total_taxes || invoice?.total_tax_amounts || []
    if (taxEntries.length) {
      for (const t of taxEntries) {
        const trId = t.tax_rate_details?.tax_rate
          || (typeof t.tax_rate === 'string' ? t.tax_rate : t.tax_rate?.id)
          || null
        const trObj = typeof t.tax_rate === 'object' ? t.tax_rate : await getTaxRate(trId)
        const kind = classifyTaxRate(trObj)
        taxDetails.push({ tax_rate: trId, amount: t.amount, kind })
        trObjs.push(trObj)
        const amt = (t.amount || 0) / 100
        if (kind === 'gst') invoiceTaxGst += amt
        else if (kind === 'qst') invoiceTaxQst += amt
      }

      // Resolve qb_tax_code: try combined key first, then single ids, then auto-infer.
      const trIds = taxDetails.map(t => t.tax_rate).filter(Boolean)
      if (trIds.length) {
        const combinedKey = [...new Set(trIds)].sort().join('+')
        if (taxMap.has(combinedKey)) qbTaxCode = taxMap.get(combinedKey)
        if (!qbTaxCode) {
          for (const id of trIds) {
            if (taxMap.has(id)) { qbTaxCode = taxMap.get(id); break }
          }
        }
        if (!qbTaxCode) {
          // N'inférer que sur les tax_rates ayant effectivement contribué un montant.
          // Stripe Tax peut attacher des taux à 0 (ex. PST BC pour vendeur non-inscrit) :
          // les inclure dans la somme des pourcentages fausse l'inférence (5 + 7 = 12 → null
          // au lieu de TPS seule = 5 → '5').
          const appliedTrObjs = trObjs.filter((_, i) => (taxDetails[i]?.amount || 0) > 0)
          const inferred = autoInferQbTaxCode(appliedTrObjs.length ? appliedTrObjs : trObjs)
          if (inferred) {
            qbTaxCode = inferred
            const key = trIds.length > 1 ? combinedKey : trIds[0]
            const desc = trObjs.filter(Boolean)
              .map(tr => `${tr.display_name || ''} ${tr.percentage}%${tr.state ? ' ' + tr.state : ''}`.trim())
              .join(' + ')
            const pct = trIds.length === 1 && trObjs[0] ? Number(trObjs[0].percentage) : null
            try {
              db.prepare(`
                INSERT OR IGNORE INTO stripe_qb_tax_mapping
                  (id, stripe_tax_id, stripe_tax_description, stripe_tax_percentage, qb_tax_code)
                VALUES (?, ?, ?, ?, ?)
              `).run(uuid(), key, desc || null, pct, inferred)
              taxMap.set(key, inferred)
              console.log(`🔗 Auto-mappé tax_rate ${key} → QB code ${inferred} (${desc})`)
            } catch (e) {
              console.error('⚠️  Auto-map insert:', e.message)
            }
          }
        }
      }
    }

    // Aucune taxe effective sur la facture. Deux formes :
    //   - Stripe Tax a bien attaché un tax_rate mais à 0 (client non-résident non
    //     facturable pour Orisha) → tax_details = [{ amount: 0 }].
    //   - automatic_tax désactivé côté Stripe → AUCUN tax_rate → tax_details = [].
    //     (abonnements créés à la main dans le dashboard : facture 92E2BD27-0016
    //     Way Farms, Deposit 17831 du 10 août 2026, poussée sans code de taxe.)
    // Le second cas passait avant à travers le filet, qui vivait à l'intérieur du
    // bloc `if (taxEntries.length)`.
    if (!qbTaxCode && invoice) {
      qbTaxCode = resolveZeroTaxCode({
        taxDetails,
        country: invoice.customer_address?.country || customer?.address?.country,
      })
    }
    // For refunds, invoice taxes flow back out — invert signs so the stored value
    // reflects the BT direction. Proratise au brut effectivement remboursé : un
    // refund partiel ne porte qu'une fraction de la taxe de la facture d'origine
    // (sinon il hérite de 100 % de la taxe → cf. proRateRefundTax). Base de
    // proratisation : le total TTC de la facture (invoice.total / amount_paid).
    if (isRefund) {
      const refundGross = Math.abs((bt.amount || 0) / 100)
      const invoiceGross = (invoice?.total ?? invoice?.amount_paid ?? 0) / 100
      invoiceTaxGst = -proRateRefundTax(invoiceTaxGst, refundGross, invoiceGross)
      invoiceTaxQst = -proRateRefundTax(invoiceTaxQst, refundGross, invoiceGross)
    }

    // Taxes que Stripe applique à ses propres frais (visible dans fee_details).
    // Signe positif = montant que Stripe nous a facturé comme taxe (CTI/RTI récupérable).
    const { taxGst: feeTaxGst, taxQst: feeTaxQst } = splitFeeDetails(bt)

    const amount = (bt.amount || 0) / 100
    const fee = (bt.fee || 0) / 100
    const net = (bt.net || 0) / 100
    const createdDate = bt.created ? new Date(bt.created * 1000).toISOString() : null
    const availableOn = bt.available_on ? new Date(bt.available_on * 1000).toISOString().slice(0, 10) : null

    const existing = db.prepare('SELECT id FROM stripe_balance_transactions WHERE stripe_id=?').get(bt.id)
    if (existing) {
      db.prepare(`
        UPDATE stripe_balance_transactions SET
          payout_stripe_id=?, type=?, reporting_category=?, amount=?, fee=?, net=?, currency=?,
          description=?, source_id=?, source_type=?, stripe_invoice_id=?, invoice_number=?,
          stripe_customer_id=?, customer_name=?, is_subscription=?, qb_tax_code=?,
          tax_details=?, invoice_tax_gst=?, invoice_tax_qst=?,
          fee_tax_gst=?, fee_tax_qst=?,
          available_on=?, created_date=?, raw=?, synced_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id=?
      `).run(
        payoutStripeId, bt.type, bt.reporting_category, amount, fee, net, (bt.currency || '').toUpperCase(),
        bt.description || null, src?.id || null, typeof bt.source === 'string' ? null : (src?.object || null),
        stripeInvoiceId, invoiceNumber, stripeCustomerId, customerName, isSubscription, qbTaxCode,
        JSON.stringify(taxDetails), invoiceTaxGst, invoiceTaxQst,
        feeTaxGst, feeTaxQst,
        availableOn, createdDate, JSON.stringify(bt),
        existing.id
      )
      updated++
    } else {
      db.prepare(`
        INSERT INTO stripe_balance_transactions (
          id, stripe_id, payout_stripe_id, type, reporting_category, amount, fee, net, currency,
          description, source_id, source_type, stripe_invoice_id, invoice_number,
          stripe_customer_id, customer_name, is_subscription, qb_tax_code,
          tax_details, invoice_tax_gst, invoice_tax_qst,
          fee_tax_gst, fee_tax_qst,
          available_on, created_date, raw
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        uuid(), bt.id, payoutStripeId, bt.type, bt.reporting_category, amount, fee, net, (bt.currency || '').toUpperCase(),
        bt.description || null, src?.id || null, typeof bt.source === 'string' ? null : (src?.object || null),
        stripeInvoiceId, invoiceNumber, stripeCustomerId, customerName, isSubscription, qbTaxCode,
        JSON.stringify(taxDetails), invoiceTaxGst, invoiceTaxQst,
        feeTaxGst, feeTaxQst,
        availableOn, createdDate, JSON.stringify(bt)
      )
      created++
    }
  }

  console.log(`✅ Balance transactions sync for ${payoutStripeId}: ${created} créés, ${updated} MAJ`)
  return { created, updated }
}

// Iterates payouts that have no synced BTs yet, calls syncStripeBalanceTransactions
// for each. Use onlyMissing=false to force resync of all payouts.
export async function syncAllPayoutsBalanceTransactions({ onlyMissing = true, limit = null } = {}) {
  const rows = onlyMissing
    ? db.prepare(`
        SELECT sp.stripe_id FROM stripe_payouts sp
        LEFT JOIN stripe_balance_transactions bt ON bt.payout_stripe_id = sp.stripe_id
        WHERE bt.id IS NULL
        GROUP BY sp.stripe_id
        ORDER BY sp.created_date
      `).all()
    : db.prepare('SELECT stripe_id FROM stripe_payouts ORDER BY created_date').all()

  const payouts = limit ? rows.slice(0, limit) : rows
  let created = 0
  let updated = 0
  const errors = []

  for (const p of payouts) {
    try {
      const r = await syncStripeBalanceTransactions(p.stripe_id)
      created += r.created || 0
      updated += r.updated || 0
    } catch (e) {
      errors.push({ payout_id: p.stripe_id, error: e.message })
    }
  }

  console.log(`✅ Bulk BT sync: ${payouts.length} payouts traités, ${created} BT créés, ${updated} MAJ, ${errors.length} erreurs`)
  return { payoutsProcessed: payouts.length, created, updated, errors }
}

// Derives a document number for a refund row in priority order :
//   1. bt.stripe_invoice_id      → numéro de la facture d'origine via factures.invoice_id
//   2. raw.source.charge         → factures.paid_charge_id ou invoice_id (legacy AT)
//   3. raw.source.payment_intent → factures.paid_payment_intent
//   4. bt.invoice_number         → fallback texte porté par le BT lui-même
// 1 cible les refunds sur Invoices Stripe ; 2-3 rattrapent les paiements directs
// (Checkout, payment links, charges PaymentIntent) où Stripe n'attache pas
// d'Invoice — sans ces fallbacks, ces refunds restent sans numéro.
// Suffixe "-R" pour distinguer le refund de la facture d'origine.
function deriveRefundDocNumber(bt) {
  if (bt.stripe_invoice_id) {
    const orig = db.prepare(
      'SELECT document_number FROM factures WHERE invoice_id=? AND document_number IS NOT NULL LIMIT 1'
    ).get(bt.stripe_invoice_id)
    if (orig?.document_number) return `${orig.document_number}-R`
  }
  let parentCharge = null, parentPI = null
  try {
    const raw = JSON.parse(bt.raw || '{}')
    parentCharge = raw?.source?.charge || null
    parentPI = raw?.source?.payment_intent || null
  } catch (e) {
    // raw illisible : on ne peut plus dériver le numéro de document via charge/PI.
    console.warn(`⚠️  [stripe] deriveRefundDocNumber: JSON.parse(raw) échoué pour BT ${bt.source_id || bt.stripe_id || bt.id} — numéro de document non résolu via charge/PI:`, e.message)
  }
  if (parentCharge) {
    const orig = db.prepare(
      'SELECT document_number FROM factures WHERE (paid_charge_id=? OR invoice_id=?) AND document_number IS NOT NULL LIMIT 1'
    ).get(parentCharge, parentCharge)
    if (orig?.document_number) return `${orig.document_number}-R`
  }
  if (parentPI) {
    const orig = db.prepare(
      'SELECT document_number FROM factures WHERE paid_payment_intent=? AND document_number IS NOT NULL LIMIT 1'
    ).get(parentPI)
    if (orig?.document_number) return `${orig.document_number}-R`
  }
  if (bt.invoice_number) return `${bt.invoice_number}-R`
  return null
}

// Pour un refund, Stripe ne renvoie pas le HT séparément — `bt.amount` est le
// brut TTC remboursé en monnaie native. On dérive le HT en appliquant le ratio
// HT/TTC de la facture d'origine, calculé en monnaie native uniquement
// (montant_avant_taxes vs total_amount) — ne PAS utiliser amount_before_tax_cad
// au numérateur car il est en CAD et mélangerait les devises pour les factures
// USD. Fallback : soustraction des taxes du BT (correct pour refund complet),
// puis le brut tel quel si aucune info disponible.
function computeRefundHt(bt, refundAmount) {
  if (bt.stripe_invoice_id) {
    const orig = db.prepare(
      `SELECT total_amount, montant_avant_taxes FROM factures
       WHERE invoice_id = ? AND total_amount > 0
       LIMIT 1`
    ).get(bt.stripe_invoice_id)
    if (orig && Number(orig.total_amount) > 0) {
      const origNativeHt = parseFloat(orig.montant_avant_taxes)
      if (Number.isFinite(origNativeHt) && origNativeHt > 0) {
        const ratio = origNativeHt / Number(orig.total_amount)
        return Math.round(refundAmount * ratio * 100) / 100
      }
    }
  }
  const taxFullInvoice = Math.abs(bt.invoice_tax_gst || 0) + Math.abs(bt.invoice_tax_qst || 0)
  if (taxFullInvoice > 0 && refundAmount > taxFullInvoice) {
    return Math.round((refundAmount - taxFullInvoice) * 100) / 100
  }
  return refundAmount
}

// Backfills the factures table from refund balance_transactions already synced.
// - One facture per refund (invoice_id = re_xxx, status = 'Remboursement')
// - Dedup multi-clé : un même refund peut exister à la fois comme ligne native
//   (invoice_id = re_xxx) et comme ligne héritée d'Airtable (invoice_id = ch_xxx,
//   le charge parent). On résout les 4 cas :
//     1. Native déjà présente               → idempotent (patch document_number si manquant,
//                                             auto-heal du HT si stocké à tort en TTC)
//     2. AT seule (ch_xxx)                  → promote : UPDATE invoice_id → re_xxx,
//                                             garde airtable_id (la sync AT préserve la promotion)
//     3. Native + AT séparées (doublon)     → merge : DELETE la ligne AT, garde la native
//     4. Aucune                              → INSERT classique
export function backfillRefundsToFactures({ dryRun = false } = {}) {
  const refundBts = db.prepare(`
    SELECT id, stripe_id, source_id, amount, fee, currency, stripe_invoice_id, invoice_number,
           stripe_customer_id, customer_name, is_subscription, created_date, raw
    FROM stripe_balance_transactions
    WHERE type IN ('refund', 'payment_refund')
    ORDER BY created_date
  `).all()

  let created = 0
  let skipped = 0
  let patched = 0
  let promoted = 0
  let mergedDups = 0
  let unmatched = 0
  const details = []

  const findRow = db.prepare(
    "SELECT id, document_number, airtable_id, amount_before_tax_cad, total_amount FROM factures WHERE invoice_id=? AND sync_source='Remboursements Stripe'"
  )

  // Refunds déjà matérialisés en payments (webhook ou migration) — à ne pas recréer en facture.
  const findExistingPayment = db.prepare(
    'SELECT 1 FROM payments WHERE stripe_refund_id = ? LIMIT 1'
  )

  for (const bt of refundBts) {
    const refundId = bt.source_id
    if (!refundId) { skipped++; continue }

    // Si ce refund est déjà en payments (webhook charge.refunded ou migration),
    // on ne re-crée pas la facture standalone — sinon on annule la migration.
    if (findExistingPayment.get(refundId)) { skipped++; continue }

    let chargeId = null
    try {
      const raw = JSON.parse(bt.raw || '{}')
      chargeId = raw?.source?.charge || null
    } catch (e) {
      // raw illisible : pas de charge parent → dédup native/AT et matching facture dégradés.
      console.warn(`⚠️  [stripe] backfillRefundsToFactures: JSON.parse(raw) échoué pour refund ${refundId} — charge parent introuvable:`, e.message)
    }

    const nativeRow = findRow.get(refundId)
    const atRow = chargeId ? findRow.get(chargeId) : null
    const refundAmount = Math.abs(bt.amount || 0)
    const refundHt = computeRefundHt(bt, refundAmount)
    const docNumber = deriveRefundDocNumber(bt)

    // Cas 3 : doublon — native + AT pour le même refund. On garde la native
    // (champs payout-aware mieux résolus) et on supprime la copie AT.
    if (nativeRow && atRow && nativeRow.id !== atRow.id) {
      if (!dryRun) {
        db.prepare('DELETE FROM factures WHERE id=?').run(atRow.id)
      }
      mergedDups++
      details.push({ refund_id: refundId, charge_id: chargeId, action: 'merged_dup', kept: nativeRow.id, deleted_at_id: atRow.id, deleted_airtable_id: atRow.airtable_id })
      continue
    }

    // Cas 1 : native déjà là — idempotent, patch document_number si manquant.
    // Auto-heal : si amount_before_tax_cad a été stocké à tort en TTC (bug
    // historique : amount_before_tax_cad == total_amount alors que la facture
    // d'origine a un HT < TTC), on le recalcule.
    if (nativeRow) {
      const needsDocPatch = !nativeRow.document_number && docNumber
      const currentHt = Number(nativeRow.amount_before_tax_cad) || 0
      const needsHtPatch =
        Number(nativeRow.total_amount) > 0
        && Math.abs(currentHt - refundHt) > 0.01
      if ((needsDocPatch || needsHtPatch) && !dryRun) {
        db.prepare(
          `UPDATE factures SET
             document_number=COALESCE(?, document_number),
             amount_before_tax_cad=?,
             montant_avant_taxes=?,
             updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE id=?`
        ).run(docNumber, refundHt, String(refundHt), nativeRow.id)
      }
      if (needsDocPatch) patched++
      skipped++
      continue
    }

    // Cas 2 : seule la ligne AT (ch_xxx) existe → promotion. On bascule
    // invoice_id sur re_xxx, on rafraîchit montants/numéro depuis le BT, et
    // on conserve airtable_id : la sync AT (services/airtable.js) ne ré-écrit
    // pas un invoice_id déjà en re_%.
    if (atRow) {
      if (!dryRun) {
        db.prepare(`
          UPDATE factures SET
            invoice_id=?,
            document_number=COALESCE(document_number, ?),
            amount_before_tax_cad=?,
            montant_avant_taxes=?,
            total_amount=CASE WHEN COALESCE(total_amount,0)=0 THEN ? ELSE total_amount END,
            balance_due=0,
            lien_stripe=?,
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id=?
        `).run(refundId, docNumber, refundHt, String(refundHt), refundAmount, `https://dashboard.stripe.com/refunds/${refundId}`, atRow.id)
      }
      promoted++
      details.push({ refund_id: refundId, charge_id: chargeId, action: 'promoted', facture_id: atRow.id, airtable_id: atRow.airtable_id })
      continue
    }

    // Cas 4 : aucune ligne — INSERT classique.
    let companyId = null
    if (bt.stripe_customer_id) {
      const co = db.prepare('SELECT id FROM companies WHERE stripe_customer_id=?').get(bt.stripe_customer_id)
      companyId = co?.id || null
    }
    if (!companyId) unmatched++

    let subscriptionId = null
    if (bt.is_subscription && bt.stripe_invoice_id) {
      const fact = db.prepare(
        "SELECT subscription_id FROM factures WHERE invoice_id=? AND subscription_id IS NOT NULL LIMIT 1"
      ).get(bt.stripe_invoice_id)
      subscriptionId = fact?.subscription_id || null
    }

    const docDate = bt.created_date ? bt.created_date.slice(0, 10) : null
    const annee = docDate ? docDate.slice(0, 4) : null

    if (dryRun) {
      created++
      details.push({ refund_id: refundId, charge_id: chargeId, amount: refundAmount, company_id: companyId, document_number: docNumber, would_create: true })
      continue
    }

    const id = uuid()
    db.prepare(`
      INSERT INTO factures (
        id, invoice_id, company_id, document_number, document_date,
        status, currency, amount_before_tax_cad, total_amount, balance_due,
        subscription_id, sync_source, customer_id, lien_stripe,
        date_equivalente, annee_de_facturation,
        montant_avant_taxes,
        created_at, updated_at
      ) VALUES (?,?,?,?,?,'Remboursement',?,?,?,0,?,'Remboursements Stripe',?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `).run(
      id, refundId, companyId, docNumber, docDate,
      bt.currency || 'CAD', refundHt, refundAmount,
      subscriptionId, bt.stripe_customer_id,
      `https://dashboard.stripe.com/refunds/${refundId}`,
      bt.created_date, annee,
      String(refundHt)
    )
    created++
    details.push({ refund_id: refundId, charge_id: chargeId, amount: refundAmount, company_id: companyId, document_number: docNumber, facture_id: id })
  }

  console.log(`✅ Backfill remboursements: ${created} créés, ${promoted} promus AT→native, ${mergedDups} doublons fusionnés, ${patched} numéros patchés, ${skipped} skip, ${unmatched} sans company sur ${refundBts.length}`)
  return { total: refundBts.length, created, promoted, mergedDups, patched, skipped, unmatched, details: details.slice(0, 50) }
}

// Migre les factures standalone de remboursement (sync_source='Remboursements Stripe')
// vers des lignes `payments` (direction='out') attachées à la facture d'origine.
// C'est l'inverse de backfillRefundsToFactures : on consolide les refunds vers le
// même format que le webhook charge.refunded moderne. Voir stripe-webhooks.js:334.
//
// Matching de la facture d'origine, dans l'ordre :
//   1. via stripe_balance_transactions.stripe_invoice_id (lien direct fiable)
//   2. via pattern document_number "XXX-R" → facture "XXX" (héritage Airtable)
//
// Skip (laisse la ligne standalone intacte) :
//   - PayoutReversal (invoice_id commence par 'pyr_') — pas un refund de charge
//   - amount = 0
//   - aucune facture d'origine trouvée
//
// Idempotent : si une ligne payments existe déjà pour ce stripe_refund_id, on
// se contente de supprimer la facture standalone (l'index UNIQUE sur
// stripe_refund_id empêche tout doublon).
export function migrateRefundsToPayments({ dryRun = false } = {}) {
  const refundFactures = db.prepare(`
    SELECT id, invoice_id, document_number, document_date, total_amount,
           amount_before_tax_cad, currency, company_id
    FROM factures
    WHERE sync_source = 'Remboursements Stripe' AND status = 'Remboursement'
  `).all()

  let migrated = 0
  let skippedExists = 0
  let skippedPyr = 0
  let skippedZero = 0
  let skippedNoMatch = 0
  const details = []

  const findBT = db.prepare(`
    SELECT id, stripe_id, source_id, stripe_invoice_id, raw, created_date
    FROM stripe_balance_transactions
    WHERE source_id = ? AND type IN ('refund', 'payment_refund') LIMIT 1
  `)
  const findOrigByInvoiceId = db.prepare(`
    SELECT id, document_number FROM factures
    WHERE invoice_id = ? AND sync_source != 'Remboursements Stripe' LIMIT 1
  `)
  const findOrigByDoc = db.prepare(`
    SELECT id, document_number FROM factures
    WHERE document_number = ? AND sync_source != 'Remboursements Stripe' LIMIT 1
  `)
  const findExistingPayment = db.prepare(
    'SELECT id FROM payments WHERE stripe_refund_id = ? LIMIT 1'
  )

  for (const rf of refundFactures) {
    const refundId = rf.invoice_id
    const amount = Number(rf.total_amount) || 0

    if (refundId && refundId.startsWith('pyr_')) {
      skippedPyr++
      details.push({ facture_id: rf.id, doc: rf.document_number, refund_id: refundId, reason: 'payout_reversal' })
      continue
    }
    if (amount === 0) {
      skippedZero++
      details.push({ facture_id: rf.id, doc: rf.document_number, refund_id: refundId, reason: 'zero_amount' })
      continue
    }

    // 1) Lookup BT to find original Stripe invoice + charge
    const bt = refundId ? findBT.get(refundId) : null
    let chargeId = null
    if (bt?.raw) {
      try { chargeId = JSON.parse(bt.raw)?.source?.charge || null }
      catch (e) {
        // raw illisible : charge parent introuvable pour la réconciliation du refund.
        console.warn(`⚠️  [stripe] migrateRefundsToPayments: JSON.parse(raw) échoué pour refund ${refundId} (facture ${rf.id}) — charge parent introuvable:`, e.message)
      }
    }

    // 2) Find original facture
    let orig = null
    if (bt?.stripe_invoice_id) {
      orig = findOrigByInvoiceId.get(bt.stripe_invoice_id)
    }
    if (!orig && rf.document_number && rf.document_number.endsWith('-R')) {
      orig = findOrigByDoc.get(rf.document_number.slice(0, -2))
    }
    if (!orig) {
      skippedNoMatch++
      details.push({ facture_id: rf.id, doc: rf.document_number, refund_id: refundId, reason: 'no_orig_facture' })
      continue
    }

    // 3) Already a payment row for this refund? Just delete the standalone facture.
    const existing = refundId ? findExistingPayment.get(refundId) : null
    if (existing) {
      if (!dryRun) {
        db.prepare('DELETE FROM factures WHERE id = ?').run(rf.id)
      }
      skippedExists++
      details.push({ facture_id: rf.id, doc: rf.document_number, refund_id: refundId, orig_doc: orig.document_number, action: 'payment_exists_facture_deleted' })
      continue
    }

    // 4) Insert payment + delete standalone facture (transactional)
    const currency = (rf.currency || 'CAD').toUpperCase()
    const receivedAt = bt?.created_date || rf.document_date || new Date().toISOString()
    const noteParts = [`Remboursement Stripe ${refundId}`]
    if (chargeId) noteParts.push(`(charge ${chargeId})`)
    noteParts.push(`— migré depuis facture standalone ${rf.document_number || rf.id}`)
    const notes = noteParts.join(' ')

    if (dryRun) {
      migrated++
      details.push({ facture_id: rf.id, doc: rf.document_number, refund_id: refundId, orig_doc: orig.document_number, amount, would_migrate: true })
      continue
    }

    const tx = db.transaction(() => {
      db.prepare(`
        INSERT INTO payments (
          id, facture_id, direction, method, received_at, amount, currency,
          stripe_refund_id, stripe_charge_id, stripe_balance_tx_id, notes,
          created_at, updated_at
        ) VALUES (?, ?, 'out', 'stripe', ?, ?, ?, ?, ?, ?, ?,
                  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      `).run(
        uuid(), orig.id, receivedAt, amount, currency,
        refundId, chargeId, bt?.stripe_id || null, notes
      )
      db.prepare('DELETE FROM factures WHERE id = ?').run(rf.id)
    })
    tx()

    migrated++
    details.push({ facture_id: rf.id, doc: rf.document_number, refund_id: refundId, orig_doc: orig.document_number, amount, action: 'migrated' })
  }

  console.log(`✅ Migration refunds → payments: ${migrated} migrés, ${skippedExists} payment existant (facture supprimée), ${skippedPyr} payout-reversal, ${skippedZero} montant nul, ${skippedNoMatch} sans match — sur ${refundFactures.length}${dryRun ? ' (DRY-RUN)' : ''}`)
  return {
    total: refundFactures.length,
    migrated,
    skipped_payment_exists: skippedExists,
    skipped_payout_reversal: skippedPyr,
    skipped_zero_amount: skippedZero,
    skipped_no_match: skippedNoMatch,
    details,
    dry_run: dryRun,
  }
}
