import { Router } from 'express'
import { randomUUID } from 'crypto'
import Stripe from 'stripe'
import db from '../db/database.js'
import { logSystemRun } from '../services/systemAutomations.js'
import { downloadStripeInvoicePdf } from '../services/stripeInvoicePdf.js'
import { recordEvent, classifyChange } from '../services/subscriptionEvents.js'
import { upsertFromInvoiceLines } from '../services/stripeInvoiceItems.js'
import {
  extractItemsFromStripeSub,
  getCurrentItemsSnapshot,
  setCurrentItemsSnapshot,
} from '../services/subscriptionItemsSnapshot.js'
import { computeMonthlyNet } from '../services/subscriptionMonthly.js'
import { recomputeFactureBalance } from '../services/factureBalance.js'

const router = Router()

function getStripeKey() {
  const row = db.prepare(
    "SELECT value FROM connector_config WHERE connector='stripe' AND key='secret_key'"
  ).get()
  return row?.value || null
}

function getWebhookSecret() {
  const row = db.prepare(
    "SELECT value FROM connector_config WHERE connector='stripe' AND key='webhook_secret'"
  ).get()
  return row?.value || null
}

// Map Stripe subscription status → ERP enum (cf. mapStatus dans services/stripe.js)
function mapSubStatus(s) {
  const m = {
    active: 'active', past_due: 'past_due', canceled: 'canceled', trialing: 'trialing',
    unpaid: 'past_due', incomplete: 'past_due', incomplete_expired: 'canceled', paused: 'canceled',
  }
  return m[s] || 'canceled'
}

// Calcule le MRR mensuel d'un sub Stripe — APRÈS rabais, AVANT taxes.
// Délègue au helper partagé pour garantir la cohérence avec la sync polling.
// Cf. subscriptionMonthly.js pour le détail (préfère latest_invoice.total_excluding_tax,
// fallback sur somme items × qty − rabais).
function computeMonthly(sub) {
  return computeMonthlyNet(sub)
}

// Traite un webhook customer.subscription.{created,updated,deleted}.
// 1. Upsert dans la table subscriptions (même logique que la sync polling).
// 2. Enregistre un subscription_event classifié, idempotent via stripe_event_id.
async function handleSubscriptionWebhook(event) {
  let sub = event.data.object
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id
  const companyId = customerId
    ? db.prepare('SELECT id FROM companies WHERE stripe_customer_id=? LIMIT 1').get(customerId)?.id || null
    : null

  // Le payload du webhook ne contient pas latest_invoice expandé — or notre
  // helper computeMonthlyNet préfère cette source pour avoir le montant net
  // (après rabais, avant taxes) cohérent avec la sync polling. Si on ne fait
  // pas ce retrieve, le webhook retombe sur le fallback "items × qty − rabais"
  // qui peut diverger d'un montant taxé (cf. incident Cabru 2026-05-08).
  // On ignore les events 'deleted' — pas besoin du montant pour un churn.
  if (event.type !== 'customer.subscription.deleted') {
    const key = getStripeKey()
    if (key) {
      try {
        const stripe = new Stripe(key)
        sub = await stripe.subscriptions.retrieve(sub.id, {
          expand: ['latest_invoice', 'items.data.price', 'discounts.source.coupon'],
        })
      } catch (e) {
        console.warn(`[stripe-webhook] retrieve sub ${sub.id} failed, falling back to payload:`, e.message)
      }
    }
  }

  const { amountMonthly, currency, intervalType } = computeMonthly(sub)
  const status = mapSubStatus(sub.status)
  const startDate = sub.start_date ? new Date(sub.start_date * 1000).toISOString().split('T')[0] : null
  const cancelDate = sub.canceled_at ? new Date(sub.canceled_at * 1000).toISOString().split('T')[0] : null
  const trialEndDate = sub.trial_end ? new Date(sub.trial_end * 1000).toISOString().split('T')[0] : null
  const stripeUrl = `https://dashboard.stripe.com/subscriptions/${sub.id}`

  const existing = db.prepare('SELECT * FROM subscriptions WHERE stripe_id=?').get(sub.id)
  let subRowId
  let prevAmount = null
  let prevStatus = null
  if (existing) {
    subRowId = existing.id
    prevAmount = existing.amount_monthly
    prevStatus = existing.status
    db.prepare(`
      UPDATE subscriptions SET
        company_id=COALESCE(?,company_id),
        status=?, amount_monthly=?, currency=?,
        start_date=?, cancel_date=?, trial_end_date=?,
        stripe_url=?, customer_id=?,
        interval_type=?
      WHERE id=?
    `).run(
      companyId, status, amountMonthly, currency,
      startDate, cancelDate, trialEndDate,
      stripeUrl, customerId,
      intervalType,
      subRowId,
    )
  } else {
    subRowId = randomUUID()
    db.prepare(`
      INSERT INTO subscriptions (
        id, company_id, stripe_id, status, amount_monthly, currency,
        start_date, cancel_date, trial_end_date, stripe_url, customer_id,
        interval_type
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      subRowId, companyId, sub.id, status, amountMonthly, currency,
      startDate, cancelDate, trialEndDate, stripeUrl, customerId,
      intervalType,
    )
  }

  // Classification de l'événement. category=null → pas un mouvement à
  // enregistrer (ex. transition active↔past_due, modification neutre).
  let category, eventDate, prevAmountForEvent, newAmountForEvent
  if (event.type === 'customer.subscription.deleted' || (status === 'canceled' && prevStatus !== 'canceled')) {
    category = 'churn'
    eventDate = cancelDate ? new Date(cancelDate).toISOString() : new Date(event.created * 1000).toISOString()
    prevAmountForEvent = prevAmount ?? amountMonthly
    newAmountForEvent = null
  } else if (event.type === 'customer.subscription.created') {
    // Si le sub arrive déjà annulé (rare : import/sub annulé immédiatement),
    // on n'enregistre pas d'event — il n'y a pas de mouvement MRR à tracer.
    if (status === 'canceled') return
    category = 'creation'
    eventDate = startDate ? new Date(startDate).toISOString() : new Date(event.created * 1000).toISOString()
    prevAmountForEvent = null
    newAmountForEvent = amountMonthly
  } else {
    // updated — compare prev/new pour détecter upgrade/downgrade/reactivation
    category = classifyChange({
      prevStatus, newStatus: status,
      prevAmount, newAmount: amountMonthly,
    })
    if (!category) return
    eventDate = new Date(event.created * 1000).toISOString()
    prevAmountForEvent = prevAmount
    newAmountForEvent = amountMonthly
  }

  // Snapshots des items : "before" depuis le miroir (état d'avant ce webhook),
  // "after" calculé depuis le payload Stripe. Pour churn, on ne stocke pas
  // d'after (sub annulé). Pour creation, pas de before.
  const itemsBeforeSnap = (category === 'creation') ? [] : (getCurrentItemsSnapshot(subRowId) || [])
  const itemsAfterSnap = (category === 'churn') ? [] : extractItemsFromStripeSub(sub)

  await recordEvent({
    subscriptionId: subRowId,
    companyId: companyId || existing?.company_id,
    eventDate,
    eventType: category,
    category,
    previousAmount: prevAmountForEvent,
    newAmount: newAmountForEvent,
    currency,
    stripeEventId: event.id,
    itemsBefore: itemsBeforeSnap,
    itemsAfter: itemsAfterSnap,
  })

  // Met à jour le miroir avec l'état nouveau (servira de "before" au prochain
  // event). Pour churn on conserve l'ancien snapshot tel quel — utile si le
  // sub est réactivé plus tard.
  if (category !== 'churn') {
    setCurrentItemsSnapshot(subRowId, itemsAfterSnap)
  }
}

function mapStripeInvoiceStatus(s) {
  const m = { paid: 'Payé', open: 'À payer', void: 'Void', uncollectible: 'Uncollectible', draft: 'Draft' }
  return m[s] || s
}

// Upsert into the factures table from a Stripe invoice object. Idempotent —
// matches by invoice_id. Updates status/totals/balance_due to reflect the
// latest Stripe state. Downloads the Stripe PDF the first time it appears.
async function upsertFactureFromStripeInvoice(invoice) {
  const total = (invoice.total || 0) / 100
  const subtotal = (invoice.subtotal || 0) / 100
  const balanceDue = (invoice.amount_remaining ?? invoice.amount_due ?? 0) / 100
  const currency = (invoice.currency || 'cad').toUpperCase()
  const invoiceDate = invoice.created ? new Date(invoice.created * 1000).toISOString().slice(0, 10) : null
  const dueDate = invoice.due_date ? new Date(invoice.due_date * 1000).toISOString().slice(0, 10) : null
  const status = mapStripeInvoiceStatus(invoice.status)

  // Encaissement : on capture date / charge / payment_intent / montant du Stripe
  // invoice si celui-ci est marqué payé. Si le statut bascule autre que 'paid'
  // (failed, voided), on reset les 4 champs pour ne pas afficher d'info trompeuse.
  let paidAt = null
  let paidAmount = null
  let paidChargeId = null
  let paidPaymentIntent = null
  if (invoice.status === 'paid') {
    const paidTs = invoice.status_transitions?.paid_at
    paidAt = paidTs ? new Date(paidTs * 1000).toISOString() : new Date().toISOString()
    paidAmount = (invoice.amount_paid ?? invoice.total ?? 0) / 100
    paidChargeId = typeof invoice.charge === 'string' ? invoice.charge : (invoice.charge?.id || null)
    // Stripe ≥ 2024 : payment_intent est sous inv.payments.data[0].payment.payment_intent
    paidPaymentIntent = invoice.payment_intent
      || invoice.payments?.data?.[0]?.payment?.payment_intent
      || null
  }
  const stripeCustomerId = typeof invoice.customer === 'string' ? invoice.customer : (invoice.customer?.id || null)
  const companyId = findCompanyByStripeCustomerId(stripeCustomerId)

  // Resolve subscription. Stripe API ≥ 2024-09 : la subscription est exposée
  // via invoice.parent.subscription_details.subscription. L'ancien champ
  // invoice.subscription est undefined dans les versions récentes — on le
  // garde en fallback pour la compatibilité événements anciens.
  let subscriptionId = null
  const subFromParent = invoice.parent?.subscription_details?.subscription
  const subFromTopLevel = invoice.subscription
  const subRaw = subFromTopLevel || subFromParent || null
  const stripeSub = typeof subRaw === 'string' ? subRaw : (subRaw?.id || null)
  if (stripeSub) {
    const subRow = db.prepare('SELECT id FROM subscriptions WHERE stripe_id=?').get(stripeSub)
    if (subRow) subscriptionId = subRow.id
  }
  // kind = 'subscription' si l'invoice Stripe vient d'un abonnement, sinon 'order'.
  // Détection sur stripeSub directement (pas subscriptionId) parce qu'on peut recevoir
  // un invoice d'abonnement avant que la subscription ait été synchronisée localement.
  const kind = stripeSub ? 'subscription' : 'order'

  const existing = db.prepare(
    "SELECT id, airtable_pdf_path FROM factures WHERE invoice_id=?"
  ).get(invoice.id)

  let factureId
  let pdfAlreadyDownloaded
  let action
  if (existing) {
    db.prepare(`
      UPDATE factures SET
        status=?, total_amount=?, amount_before_tax_cad=?, balance_due=?,
        currency=?,
        document_date=COALESCE(document_date, ?),
        document_number=COALESCE(document_number, ?),
        due_date=COALESCE(?, due_date),
        subscription_id=COALESCE(subscription_id, ?),
        company_id=COALESCE(company_id, ?),
        kind=?,
        montant_avant_taxes=?,
        paid_at=?, paid_amount=?, paid_charge_id=?, paid_payment_intent=?,
        sync_source='Factures Stripe',
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id=?
    `).run(status, total, subtotal, balanceDue, currency, invoiceDate, invoice.number || null,
      dueDate, subscriptionId, companyId, kind, String(subtotal),
      paidAt, paidAmount, paidChargeId, paidPaymentIntent, existing.id)
    factureId = existing.id
    pdfAlreadyDownloaded = !!existing.airtable_pdf_path
    action = 'updated'
  } else {
    factureId = randomUUID()
    db.prepare(`
      INSERT INTO factures (id, invoice_id, company_id, document_number, document_date, due_date,
        status, currency, amount_before_tax_cad, total_amount, balance_due,
        subscription_id, kind, sync_source, montant_avant_taxes,
        paid_at, paid_amount, paid_charge_id, paid_payment_intent,
        created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'Factures Stripe',?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `).run(factureId, invoice.id, companyId, invoice.number || null, invoiceDate, dueDate,
      status, currency, subtotal, total, balanceDue, subscriptionId, kind, String(subtotal),
      paidAt, paidAmount, paidChargeId, paidPaymentIntent)
    pdfAlreadyDownloaded = false
    action = 'created'
  }

  if (!pdfAlreadyDownloaded && invoice.invoice_pdf) {
    try {
      const relPath = await downloadStripeInvoicePdf(invoice, factureId)
      if (relPath) db.prepare('UPDATE factures SET airtable_pdf_path=? WHERE id=?').run(relPath, factureId)
    } catch (e) {
      console.error(`❌ Stripe PDF dl ${factureId}:`, e.message)
    }
  }

  // Réconcilie balance_due / status avec d'éventuels paiements locaux (Interac,
  // chèque…). No-op si paid_at est posé (Stripe est autoritaire) ou si rien
  // n'a changé. Voir services/factureBalance.js pour la règle.
  recomputeFactureBalance(factureId)

  return { id: factureId, action, kind }
}

// (Plus de fonction recordStripeInvoicePayment ici : avec le pattern simple, le
// revenu est constaté au payout via pushDepositFromPayout. Le webhook invoice.paid
// se contente d'upsert la facture dans factures via upsertFactureFromStripeInvoice.)

// Send a recovery email to the customer with a link back to the onboarding
// wizard. Used after checkout.session.completed so they can complete the form
// even if they close the tab.
async function sendOnboardingRecoveryEmail(session) {
  const recipient = session.customer_details?.email || null
  if (!recipient) return
  const baseUrl = (process.env.APP_URL || 'https://customer.orisha.io').replace(/\/$/, '')
  const wizardUrl = `${baseUrl}/erp/customer/post-payment?session_id=${session.id}`
  const customerName = session.customer_details?.name || ''
  const greeting = customerName ? `Bonjour ${customerName.split(' ')[0]},` : 'Bonjour,'
  const html = `<!DOCTYPE html>
<html><body style="font-family:Arial,sans-serif;color:#1f2937;line-height:1.5;">
<p>${greeting}</p>
<p>Merci pour votre achat chez Orisha. Pour finaliser votre installation, nous avons besoin de quelques informations techniques (adresse de la ferme, configuration du réseau, dimensions des serres, etc.).</p>
<p><a href="${wizardUrl}" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 16px;text-decoration:none;border-radius:6px;font-weight:600;">Compléter le formulaire</a></p>
<p>Vous pouvez quitter le formulaire et y revenir avec ce même lien — vos réponses sont sauvegardées automatiquement.</p>
<p>Merci,<br/>L'équipe Orisha</p>
</body></html>`
  // Try sending via the first connected Gmail account (system-level)
  const { sendEmail } = await import('../services/gmail.js')
  const sysAccount = db.prepare(
    "SELECT account_email FROM connector_oauth WHERE connector='google' AND refresh_token IS NOT NULL ORDER BY updated_at DESC LIMIT 1"
  ).get()
  if (!sysAccount?.account_email) {
    console.log('No Gmail account available — skipping recovery email')
    return
  }
  await sendEmail(recipient, "Finalisation de votre installation Orisha", html, { accountEmail: sysAccount.account_email })
}

function findCompanyByStripeCustomerId(stripeCustomerId) {
  if (!stripeCustomerId) return null
  const row = db.prepare(
    'SELECT id FROM companies WHERE stripe_customer_id=? LIMIT 1'
  ).get(stripeCustomerId)
  return row?.id || null
}

// charge.refunded → crée une ligne payments négative (direction='out') sur la facture
// d'origine (pas une nouvelle facture) et pose la JE QB adaptée à l'état comptable
// (avant constat, après constat AR ouvert, après constat soldé, abonnement).
// Idempotent par stripe_refund_id (UNIQUE).
async function handleChargeRefunded({ req: _req, res, event, secretKey: _secretKey, started }) {
  const charge = event.data.object
  const refunds = charge?.refunds?.data || []

  if (!refunds.length) {
    logSystemRun('sys_stripe_charge_refunded', {
      status: 'skipped',
      result: `Charge ${charge?.id} sans refund — ignoré.`,
      duration_ms: Date.now() - started,
      triggerData: { charge_id: charge?.id },
    })
    return res.json({ received: true, no_refunds: true })
  }

  try {
    const stripeCustomerId = typeof charge.customer === 'string' ? charge.customer : charge.customer?.id || null
    const customerEmail = charge.billing_details?.email || charge.receipt_email || null
    const customerName = charge.billing_details?.name || null

    // Trouver la facture d'origine via charge.invoice → factures.invoice_id.
    let origFacture = null
    let matchMethod = null
    if (charge.invoice) {
      const stripeInvoiceId = typeof charge.invoice === 'string' ? charge.invoice : charge.invoice?.id
      origFacture = db.prepare(
        'SELECT id, document_number, currency FROM factures WHERE invoice_id=? LIMIT 1'
      ).get(stripeInvoiceId)
      if (origFacture) matchMethod = 'invoice_id'
    }

    // Fallback : charge sans invoice rattachée (paiement direct dans Stripe Dashboard,
    // sub avec collection_method=charge_automatically pré-configuré, etc.).
    // On cherche la facture par customer + montant + période proche (±35 jours).
    if (!origFacture && stripeCustomerId) {
      const company = db.prepare('SELECT id FROM companies WHERE stripe_customer_id = ?').get(stripeCustomerId)
      if (company) {
        const chargeAmount = (charge.amount || 0) / 100
        const chargeDate = charge.created ? new Date(charge.created * 1000).toISOString().slice(0, 10) : null
        const candidates = chargeDate
          ? db.prepare(`
              SELECT id, document_number, currency, total_amount, document_date, ABS(julianday(document_date) - julianday(?)) AS dist
              FROM factures
              WHERE company_id = ? AND ABS(total_amount - ?) < 0.02
                AND sync_source != 'Remboursements Stripe'
                AND ABS(julianday(document_date) - julianday(?)) <= 35
              ORDER BY dist LIMIT 5
            `).all(chargeDate, company.id, chargeAmount, chargeDate)
          : []
        if (candidates.length === 1) {
          origFacture = candidates[0]
          matchMethod = `customer+amount+date (${candidates[0].document_date}, dist=${Number(candidates[0].dist).toFixed(0)}j)`
        } else if (candidates.length > 1) {
          // Ambigu — on prend la plus proche dans le temps mais on log
          origFacture = candidates[0]
          matchMethod = `ambigu — ${candidates.length} candidates, plus proche=${candidates[0].document_number}`
        }
      }
    }

    if (!origFacture) {
      logSystemRun('sys_stripe_charge_refunded', {
        status: 'error',
        error: `Facture d'origine introuvable (charge=${charge.id}, customer=${stripeCustomerId}, montant=${(charge.amount||0)/100}) — refund non rattaché`,
        duration_ms: Date.now() - started,
        triggerData: { charge_id: charge.id, refunds_count: refunds.length },
      })
      return res.json({ received: true, error: 'no_origin_facture', refunds_count: refunds.length })
    }

    const currency = (charge.currency || 'cad').toUpperCase()
    let createdCount = 0
    let skippedCount = 0
    const results = []

    for (const refund of refunds) {
      if (refund.status !== 'succeeded') { skippedCount++; continue }

      // Idempotence : un refund Stripe (re_xxx) ne crée qu'une ligne payments grâce
      // à l'index UNIQUE sur stripe_refund_id (cf. schema.js).
      const existing = db.prepare(
        'SELECT id, qb_payment_id, qb_journal_entry_id FROM payments WHERE stripe_refund_id=? LIMIT 1'
      ).get(refund.id)

      let paymentId = existing?.id
      if (!paymentId) {
        paymentId = randomUUID()
        const refundAmount = (refund.amount || 0) / 100
        const receivedAt = refund.created ? new Date(refund.created * 1000).toISOString() : new Date().toISOString()
        db.prepare(`
          INSERT INTO payments (
            id, facture_id, direction, method, received_at, amount, currency,
            stripe_refund_id, stripe_charge_id, notes
          ) VALUES (?, ?, 'out', 'stripe', ?, ?, ?, ?, ?, ?)
        `).run(
          paymentId, origFacture.id, receivedAt, refundAmount, currency,
          refund.id, charge.id,
          `Remboursement Stripe ${refund.id} (charge ${charge.id})`
        )
        createdCount++
      } else if (existing.qb_payment_id || existing.qb_journal_entry_id) {
        skippedCount++
        results.push({ refund_id: refund.id, payment_id: paymentId, skipped: 'already_posted' })
        continue
      }

      // Pas de pose comptable QB ici : le refund sera comptabilisé au payout
      // via pushDepositFromPayout (ligne négative dans le Deposit, Cr revenue
      // ou AR selon état). On garde juste la trace en DB pour la traçabilité.
      results.push({ refund_id: refund.id, payment_id: paymentId, status: 'tracked' })
    }

    const appUrl = (process.env.APP_URL || 'https://customer.orisha.io').replace(/\/$/, '')
    const lines = [
      `Charge ${charge.id} — ${refunds.length} refund(s) reçu(s).`,
      `Client : ${customerName || customerEmail || stripeCustomerId || 'N/A'}`,
      `Facture d'origine : #${origFacture.document_number || origFacture.id} (match=${matchMethod}) → ${appUrl}/erp/factures/${origFacture.id}`,
      `Payments créés : ${createdCount}, ignorés : ${skippedCount}`,
      ...results.map(r => {
        const qbId = r.qb_refund_receipt || r.qb_je
        const qbType = r.qb_refund_receipt ? 'RR' : (r.qb_je ? 'JE' : null)
        if (qbId) return `  ✓ ${r.refund_id} → ${qbType} ${qbId} (Dr ${r.debit} / Cr ${r.credit})`
        if (r.qb_error) return `  ⚠️ ${r.refund_id} → échouée : ${r.qb_error}`
        return `  · ${r.refund_id} → ${r.skipped || 'ok'}`
      }),
    ]

    logSystemRun('sys_stripe_charge_refunded', {
      status: results.some(r => r.qb_error) ? 'error' : 'success',
      result: lines.join('\n'),
      duration_ms: Date.now() - started,
      triggerData: { charge_id: charge.id, refunds_count: refunds.length, created: createdCount, facture_id: origFacture.id },
    })

    return res.json({ received: true, facture_id: origFacture.id, created: createdCount, skipped: skippedCount, results })
  } catch (err) {
    console.error('charge.refunded processing error:', err.message)
    logSystemRun('sys_stripe_charge_refunded', {
      status: 'error',
      error: err.message,
      duration_ms: Date.now() - started,
      triggerData: { charge_id: charge?.id },
    })
    return res.status(500).json({ error: err.message })
  }
}

// POST /api/stripe-webhooks and POST /api/stripe-webhooks/:legacy (backward compat with Stripe dashboard)
async function handleWebhook(req, res) {
  const started = Date.now()
  const secretKey = getStripeKey()
  if (!secretKey) return res.status(400).json({ error: 'Stripe non configuré' })

  const webhookSecret = getWebhookSecret()
  if (!webhookSecret) {
    console.error('Stripe webhook rejected: webhook_secret not configured')
    logSystemRun('sys_stripe_invoice_paid', {
      status: 'error',
      error: 'webhook_secret manquant — webhook refusé (fail closed).',
      duration_ms: Date.now() - started,
    })
    return res.status(503).json({ error: 'Webhook secret non configuré' })
  }

  let event
  const sig = req.headers['stripe-signature']
  try {
    const stripe = new Stripe(secretKey)
    event = stripe.webhooks.constructEvent(req.rawBody, sig, webhookSecret)
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message)
    logSystemRun('sys_stripe_invoice_paid', {
      status: 'error',
      error: `Signature invalide: ${err.message}`,
      duration_ms: Date.now() - started,
    })
    return res.status(400).json({ error: 'Signature invalide' })
  }

  if (event.type === 'charge.refunded') {
    return handleChargeRefunded({ req, res, event, secretKey, started })
  }

  // checkout.session.completed — a customer paid via the Checkout Session
  // generated from a pending_invoice. Mark pending as paid and link the new
  // Stripe invoice (created via Checkout's invoice_creation). Then send the
  // customer a recovery email with the wizard link, so they can come back
  // even if they close the tab.
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object
    const pendingId = session.metadata?.erp_pending_invoice_id || null
    const stripeInvoiceId = typeof session.invoice === 'string' ? session.invoice : session.invoice?.id || null
    if (pendingId) {
      try {
        db.prepare(`
          UPDATE pending_invoices
          SET status='paid', paid_invoice_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id=? AND status != 'paid'
        `).run(stripeInvoiceId, pendingId)
      } catch (e) { console.error('pending paid update error:', e.message) }
    }

    // Fire-and-forget recovery email (don't fail the webhook if Gmail is down)
    sendOnboardingRecoveryEmail(session).catch(e => console.error('recovery email error:', e.message))

    logSystemRun('sys_stripe_invoice_paid', {
      status: 'success',
      result: `checkout.session.completed → pending=${pendingId} → invoice=${stripeInvoiceId}`,
      duration_ms: Date.now() - started,
      triggerData: { stripe_event: event.type, session_id: session.id, pending_invoice_id: pendingId, stripe_invoice_id: stripeInvoiceId },
    })
    return res.json({ received: true, pending_invoice_id: pendingId, stripe_invoice_id: stripeInvoiceId })
  }

  // customer.subscription.* — alimente le journal des événements
  // d'abonnement (panel "Mouvements d'abonnements" du dashboard). On
  // upsert d'abord la subscription via la même logique que la sync
  // polling, puis on enregistre l'événement classifié.
  const SUBSCRIPTION_EVENTS = new Set([
    'customer.subscription.created',
    'customer.subscription.updated',
    'customer.subscription.deleted',
  ])
  if (SUBSCRIPTION_EVENTS.has(event.type)) {
    try {
      await handleSubscriptionWebhook(event)
      logSystemRun('sys_stripe_invoice_paid', {
        status: 'success',
        result: `${event.type} ${event.data.object.id}`,
        duration_ms: Date.now() - started,
        triggerData: { stripe_event: event.type, subscription_id: event.data.object.id },
      })
    } catch (e) {
      console.error(`[stripe-webhook] ${event.type} error:`, e.message)
      logSystemRun('sys_stripe_invoice_paid', {
        status: 'error',
        error: e.message,
        duration_ms: Date.now() - started,
        triggerData: { stripe_event: event.type, subscription_id: event.data.object?.id },
      })
    }
    return res.json({ received: true, subscription_id: event.data.object.id })
  }

  // Sync the factures table for any meaningful invoice lifecycle event so that
  // unpaid invoices (overdue, etc.) appear in the ERP — not only paid ones.
  const HANDLED_INVOICE_EVENTS = new Set([
    'invoice.created',
    'invoice.finalized',
    'invoice.paid',
    'invoice.payment_failed',
    'invoice.voided',
    'invoice.marked_uncollectible',
    'invoice.updated',
    'invoice.deleted',
  ])
  if (!HANDLED_INVOICE_EVENTS.has(event.type)) {
    return res.json({ received: true, ignored: true })
  }

  const invoice = event.data.object

  // invoice.deleted — only fires for drafts that get deleted in Stripe.
  // Mirror the deletion in our factures table so the row disappears from the list.
  if (event.type === 'invoice.deleted') {
    const existing = db.prepare('SELECT id FROM factures WHERE invoice_id=?').get(invoice.id)
    if (existing) {
      db.prepare('DELETE FROM factures WHERE id=?').run(existing.id)
    }
    logSystemRun('sys_stripe_invoice_paid', {
      status: 'success',
      result: `invoice.deleted ${invoice.id} → facture ERP supprimée${existing ? '' : ' (déjà absente)'}`,
      duration_ms: Date.now() - started,
      triggerData: { stripe_event: event.type, stripe_invoice_id: invoice.id },
    })
    return res.json({ received: true, deleted: !!existing })
  }

  try {
    const customerName = invoice.customer_name || invoice.customer_email || null
    const customerEmail = invoice.customer_email || null
    const factureInfo = await upsertFactureFromStripeInvoice(invoice)

    // Upsert idempotent des lignes de facture dans stripe_invoice_items.
    // Indispensable pour que le panel "Mouvements d'abonnements" du dashboard
    // affiche les produits associés (jointure factures → stripe_invoice_items).
    // Si lines.has_more=true (sub avec >10 items), on fetch via listLineItems
    // pour récupérer la totalité — sinon on utilise les lignes inline (moins
    // d'API calls). Erreurs loggées mais non bloquantes pour le webhook.
    if (factureInfo?.id) {
      try {
        let lines = invoice.lines?.data || []
        if (invoice.lines?.has_more) {
          const stripe = new Stripe(secretKey)
          const allLines = []
          for await (const ln of stripe.invoices.listLineItems(invoice.id, { limit: 100, expand: ['data.price'] })) {
            allLines.push(ln)
          }
          lines = allLines
        }
        if (lines.length > 0) {
          const r = upsertFromInvoiceLines(factureInfo.id, invoice.id, lines)
          console.log(`  ↳ stripe_invoice_items: ${r.inserted} inséré(s), ${r.updated} maj`)
        }
      } catch (e) {
        console.error(`❌ upsertFromInvoiceLines ${invoice.id}:`, e.message)
      }
    }

    // Pas de pose comptable QB ici : le revenu est constaté au payout (lundi)
    // via pushDepositFromPayout. Le constat de vente final pour les commandes
    // se fait à l'expédition via recognizeRevenueForOrder (hook shipments.status='Envoyé').
    console.log(`✅ Stripe ${event.type} ${invoice.id} → facture ${factureInfo?.action || 'no-op'}`)
    const appUrl = (process.env.APP_URL || 'https://customer.orisha.io').replace(/\/$/, '')
    const resultLines = [
      `${event.type} — facture Stripe ${invoice.number || invoice.id}`,
      `Client : ${customerName || customerEmail || 'N/A'}`,
      `Montant : ${((invoice.total || 0) / 100).toFixed(2)} ${(invoice.currency || 'cad').toUpperCase()}`,
      `Statut Stripe : ${invoice.status}`,
      `Type ERP : ${factureInfo?.kind || 'order'}`,
    ]
    if (factureInfo) {
      resultLines.push(`Facture ${factureInfo.action} : ${factureInfo.id}`, `${appUrl}/erp/factures/${factureInfo.id}`)
    }
    logSystemRun('sys_stripe_invoice_paid', {
      status: 'success',
      result: resultLines.join('\n'),
      duration_ms: Date.now() - started,
      triggerData: { stripe_event: event.type, stripe_invoice_id: invoice.id, total: invoice.total, currency: invoice.currency },
    })
    res.json({ received: true, id: factureInfo?.id || null, action: factureInfo?.action || 'noop' })
  } catch (err) {
    console.error('Stripe webhook processing error:', err.message)
    logSystemRun('sys_stripe_invoice_paid', {
      status: 'error',
      error: err.message,
      duration_ms: Date.now() - started,
      triggerData: { stripe_invoice_id: invoice?.id },
    })
    res.status(500).json({ error: err.message })
  }
}

router.post('/', handleWebhook)
router.post('/:legacy', handleWebhook)

export default router
