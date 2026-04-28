import Stripe from 'stripe'
import { v4 as uuid } from 'uuid'
import db from '../db/database.js'

function getStripeKey() {
  const row = db.prepare(
    "SELECT value FROM connector_config WHERE connector='stripe' AND key='secret_key'"
  ).get()
  return row?.value || null
}

export function isStripeConfigured() {
  return !!getStripeKey()
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
          const refund = await stripe.refunds.retrieve(refundId).catch(() => null)
          if (refund) chargeId = typeof refund.charge === 'string' ? refund.charge : refund.charge?.id
        }
      }

      if (chargeId) {
        const charge = await stripe.charges.retrieve(chargeId)
        stripeInvoiceId = typeof charge.invoice === 'string' ? charge.invoice : charge.invoice?.id
        if (stripeInvoiceId && !charge.invoice?.number) {
          const inv = await stripe.invoices.retrieve(stripeInvoiceId).catch(() => null)
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
    expand: ['data.customer', 'data.items.data.price', 'data.latest_invoice'],
  })) {
    allSubs.push(sub)
  }
  for await (const sub of stripe.subscriptions.list({
    status: 'canceled',
    limit: 100,
    expand: ['data.customer', 'data.items.data.price', 'data.latest_invoice'],
  })) {
    allSubs.push(sub)
  }

  console.log(`🔄 Stripe: ${allSubs.length} abonnement(s) récupérés (actifs + annulés)`)

  for (const sub of allSubs) {
    const customer = sub.customer
    const customerId = typeof customer === 'object' ? customer.id : customer
    const customerEmail = typeof customer === 'object' ? (customer.email || null) : null

    // Resolve company — strictement par stripe_customer_id
    let companyId = customerId
      ? db.prepare('SELECT id FROM companies WHERE stripe_customer_id=? LIMIT 1').get(customerId)?.id || null
      : null

    // If no match, keep existing link if updating
    const existingRow = db.prepare(
      "SELECT id, company_id FROM subscriptions WHERE stripe_id=?"
    ).get(sub.id)
    if (!companyId && existingRow?.company_id) companyId = existingRow.company_id

    // Price / interval info — sum ALL items (subscriptions can have multiple line items)
    const items = sub.items?.data ?? []
    const firstPrice = items[0]?.price
    const currency = (firstPrice?.currency ?? 'cad').toUpperCase()
    const intervalType = firstPrice?.recurring?.interval ?? 'month'
    const intervalCount = firstPrice?.recurring?.interval_count ?? 1

    // Use latest invoice total (includes discounts) when available, fall back to summing items
    const latestInvoice = typeof sub.latest_invoice === 'object' ? sub.latest_invoice : null
    let amountMonthly
    if (latestInvoice && latestInvoice.total != null) {
      amountMonthly = latestInvoice.total / 100
      // Normalize to monthly if interval is not month
      if (intervalType === 'year') amountMonthly = amountMonthly / 12
      else if (intervalType === 'week') amountMonthly = amountMonthly * 4.333
    } else {
      amountMonthly = 0
      for (const item of items) {
        const p = item?.price
        const unitAmt = (p?.unit_amount ?? 0) / 100
        const qty = item?.quantity ?? 1
        const iType = p?.recurring?.interval ?? 'month'
        let monthlyPart = unitAmt * qty
        if (iType === 'year') monthlyPart = monthlyPart / 12
        else if (iType === 'week') monthlyPart = monthlyPart * 4.333
        amountMonthly += monthlyPart
      }
    }

    const status = mapStatus(sub.status)
    const startDate = sub.start_date
      ? new Date(sub.start_date * 1000).toISOString().split('T')[0]
      : null
    const cancelDate = sub.canceled_at
      ? new Date(sub.canceled_at * 1000).toISOString().split('T')[0]
      : null
    const trialEndDate = sub.trial_end
      ? new Date(sub.trial_end * 1000).toISOString().split('T')[0]
      : null
    const stripeUrl = `https://dashboard.stripe.com/subscriptions/${sub.id}`

    if (existingRow) {
      // Detect changes and log them
      const prev = db.prepare('SELECT * FROM subscriptions WHERE id=?').get(existingRow.id)
      const changes = []
      if (prev.status !== status) changes.push(`Statut: ${prev.status} → ${status}`)
      if (Math.abs((prev.amount_monthly || 0) - amountMonthly) > 0.01) changes.push(`Montant: ${(prev.amount_monthly || 0).toFixed(2)} → ${amountMonthly.toFixed(2)} ${currency}`)
      if (prev.cancel_date !== cancelDate) {
        if (!prev.cancel_date && cancelDate) changes.push(`Annulé le ${cancelDate}`)
        else if (prev.cancel_date && !cancelDate) changes.push('Annulation retirée')
      }
      if (prev.interval_type !== intervalType || prev.interval_count !== intervalCount) {
        changes.push(`Intervalle: ${prev.interval_count || 1} ${prev.interval_type || 'month'} → ${intervalCount} ${intervalType}`)
      }

      if (changes.length > 0) {
        db.prepare('INSERT INTO subscription_events (id, subscription_id, event_date, event_type, details) VALUES (?,?,datetime(\'now\'),?,?)')
          .run(uuid(), existingRow.id, 'update', JSON.stringify(changes))
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
      db.prepare('INSERT INTO subscription_events (id, subscription_id, event_date, event_type, details) VALUES (?,?,?,?,?)')
        .run(uuid(), newId, startDate || new Date().toISOString(), 'creation', JSON.stringify([`Création: ${amountMonthly.toFixed(2)} ${currency}/${intervalType}`]))
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
function classifyTaxRate(tr) {
  if (!tr) return null
  const name = `${tr.display_name || ''} ${tr.description || ''}`.toLowerCase()
  if (/\b(qst|tvq)\b/.test(name)) return 'qst'
  if (/\b(gst|tps|hst|tvh)\b/.test(name)) return 'gst'
  const pct = Number(tr.percentage)
  if (Number.isFinite(pct)) {
    if (Math.abs(pct - 9.975) < 0.1) return 'qst'
    if (Math.abs(pct - 5) < 0.1) return 'gst'
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
      } catch {}
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
          const inferred = autoInferQbTaxCode(trObjs)
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
      // Stripe Tax attache un tax_rate (ex. US state tax) mais la taxe effective est 0 —
      // client non-résident non facturable pour Orisha. Code QB "Détaxé" (exports de biens,
      // services/licences à non-résidents), pour que la vente apparaisse à la ligne 101 de
      // la déclaration TPS. Pas persisté en mapping: le même tax_rate peut redevenir non-nul
      // si Orisha s'inscrit dans cette juridiction.
      if (!qbTaxCode && taxDetails.every(t => (t.amount || 0) === 0)) {
        qbTaxCode = '4'
      }
    }
    // For refunds, invoice taxes flow back out — invert signs so the stored value reflects the BT direction.
    if (isRefund) {
      invoiceTaxGst = -invoiceTaxGst
      invoiceTaxQst = -invoiceTaxQst
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

// Derives a document number for a refund row. Prefers the original invoice's
// document_number (from the factures table, matched via bt.stripe_invoice_id);
// falls back to bt.invoice_number if the original facture isn't found locally.
// Suffix "-R" so the UI can distinguish refunds from invoices at a glance.
function deriveRefundDocNumber(bt) {
  if (bt.stripe_invoice_id) {
    const orig = db.prepare(
      'SELECT document_number FROM factures WHERE invoice_id=? AND document_number IS NOT NULL LIMIT 1'
    ).get(bt.stripe_invoice_id)
    if (orig?.document_number) return `${orig.document_number}-R`
  }
  if (bt.invoice_number) return `${bt.invoice_number}-R`
  return null
}

// Backfills the factures table from refund balance_transactions already synced.
// - One facture per refund (invoice_id = re_xxx, status = 'Remboursement')
// - Skips if a facture already exists with same invoice_id + sync_source
//   (but still patches document_number if it was missing on the existing row)
// - Does NOT touch existing Airtable refund rows (different invoice_id format = ch_xxx)
// Note: amount_before_tax_cad is set to total_amount since BT doesn't carry the tax
// breakdown — refine later by fetching the original invoice if needed.
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
  let unmatched = 0
  const details = []

  for (const bt of refundBts) {
    const refundId = bt.source_id
    if (!refundId) { skipped++; continue }

    const existing = db.prepare(
      "SELECT id, document_number FROM factures WHERE invoice_id=? AND sync_source='Remboursements Stripe'"
    ).get(refundId)
    if (existing) {
      if (!existing.document_number) {
        const docNum = deriveRefundDocNumber(bt)
        if (docNum && !dryRun) {
          db.prepare(
            `UPDATE factures SET document_number=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`
          ).run(docNum, existing.id)
        }
        if (docNum) patched++
      }
      skipped++
      continue
    }

    let chargeId = null
    try {
      const raw = JSON.parse(bt.raw || '{}')
      chargeId = raw?.source?.charge || null
    } catch {}

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

    const refundAmount = Math.abs(bt.amount || 0)
    const docDate = bt.created_date ? bt.created_date.slice(0, 10) : null
    const moisDoc = docDate ? docDate.slice(0, 7) : null
    const annee = docDate ? docDate.slice(0, 4) : null
    const docNumber = deriveRefundDocNumber(bt)

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
        date_equivalente, mois_du_document, annee_de_facturation,
        montant_avant_taxes,
        created_at, updated_at
      ) VALUES (?,?,?,?,?,'Remboursement',?,?,?,0,?,'Remboursements Stripe',?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `).run(
      id, refundId, companyId, docNumber, docDate,
      bt.currency || 'CAD', refundAmount, refundAmount,
      subscriptionId, bt.stripe_customer_id,
      `https://dashboard.stripe.com/refunds/${refundId}`,
      bt.created_date, moisDoc, annee,
      String(refundAmount)
    )
    created++
    details.push({ refund_id: refundId, charge_id: chargeId, amount: refundAmount, company_id: companyId, document_number: docNumber, facture_id: id })
  }

  console.log(`✅ Backfill remboursements: ${created} créés, ${patched} numéros patchés, ${skipped} skip, ${unmatched} sans company sur ${refundBts.length}`)
  return { total: refundBts.length, created, patched, skipped, unmatched, details: details.slice(0, 50) }
}
