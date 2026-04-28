import { Router } from 'express'
import { randomUUID } from 'crypto'
import Stripe from 'stripe'
import db from '../db/database.js'
import { logSystemRun } from '../services/systemAutomations.js'
import { downloadStripeInvoicePdf } from '../services/stripeInvoicePdf.js'

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
  const stripeCustomerId = typeof invoice.customer === 'string' ? invoice.customer : (invoice.customer?.id || null)
  const companyId = findCompanyByStripeCustomerId(stripeCustomerId)

  // Resolve subscription
  let subscriptionId = null
  const stripeSub = typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id
  if (stripeSub) {
    const subRow = db.prepare('SELECT id FROM subscriptions WHERE stripe_id=?').get(stripeSub)
    if (subRow) subscriptionId = subRow.id
  }

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
        montant_avant_taxes=?,
        sync_source='Factures Stripe',
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id=?
    `).run(status, total, subtotal, balanceDue, currency, invoiceDate, invoice.number || null,
      dueDate, subscriptionId, companyId, String(subtotal), existing.id)
    factureId = existing.id
    pdfAlreadyDownloaded = !!existing.airtable_pdf_path
    action = 'updated'
  } else {
    factureId = randomUUID()
    db.prepare(`
      INSERT INTO factures (id, invoice_id, company_id, document_number, document_date, due_date,
        status, currency, amount_before_tax_cad, total_amount, balance_due,
        subscription_id, sync_source, montant_avant_taxes, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'Factures Stripe',?,strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `).run(factureId, invoice.id, companyId, invoice.number || null, invoiceDate, dueDate,
      status, currency, subtotal, total, balanceDue, subscriptionId, String(subtotal))
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

  return { id: factureId, action }
}

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

// charge.refunded → insert one facture per succeeded refund (sync_source='Remboursements Stripe').
// Dedup by invoice_id=re_xxx (the refund id, unique per refund event).
async function handleChargeRefunded({ req: _req, res, event, secretKey, started }) {
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
    const stripe = new Stripe(secretKey)
    const stripeCustomerId = typeof charge.customer === 'string' ? charge.customer : charge.customer?.id || null
    const customerEmail = charge.billing_details?.email || charge.receipt_email || null
    const customerName = charge.billing_details?.name || null

    const companyId = findCompanyByStripeCustomerId(stripeCustomerId)

    let subscriptionId = null
    let origDocNumber = null
    let origInvoiceNumber = null
    if (charge.invoice) {
      const stripeInvoiceId = typeof charge.invoice === 'string' ? charge.invoice : charge.invoice?.id
      try {
        const inv = typeof charge.invoice === 'object'
          ? charge.invoice
          : await stripe.invoices.retrieve(stripeInvoiceId)
        const stripeSub = typeof inv.subscription === 'string' ? inv.subscription : inv.subscription?.id
        if (stripeSub) {
          const subRow = db.prepare('SELECT id FROM subscriptions WHERE stripe_id=?').get(stripeSub)
          subscriptionId = subRow?.id || null
        }
        origInvoiceNumber = inv.number || null
      } catch (e) {
        console.error('Could not resolve subscription for refund:', e.message)
      }
      const origFact = db.prepare(
        'SELECT document_number FROM factures WHERE invoice_id=? AND document_number IS NOT NULL LIMIT 1'
      ).get(stripeInvoiceId)
      origDocNumber = origFact?.document_number || origInvoiceNumber || null
    }

    const currency = (charge.currency || 'cad').toUpperCase()
    let createdCount = 0
    let skippedCount = 0
    const insertedIds = []

    for (const refund of refunds) {
      if (refund.status !== 'succeeded') { skippedCount++; continue }

      const existing = db.prepare(
        "SELECT id FROM factures WHERE invoice_id=? AND sync_source='Remboursements Stripe'"
      ).get(refund.id)
      if (existing) { skippedCount++; continue }

      const refundAmount = (refund.amount || 0) / 100
      const createdIso = refund.created ? new Date(refund.created * 1000).toISOString() : null
      const docDate = createdIso ? createdIso.slice(0, 10) : null
      const moisDoc = docDate ? docDate.slice(0, 7) : null
      const annee = docDate ? docDate.slice(0, 4) : null

      const id = randomUUID()
      const docNumber = origDocNumber ? `${origDocNumber}-R` : null
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
        id, refund.id, companyId, docNumber, docDate,
        currency, refundAmount, refundAmount,
        subscriptionId, stripeCustomerId,
        `https://dashboard.stripe.com/refunds/${refund.id}`,
        createdIso, moisDoc, annee,
        String(refundAmount)
      )
      createdCount++
      insertedIds.push(id)
    }

    const appUrl = (process.env.APP_URL || 'https://customer.orisha.io').replace(/\/$/, '')
    const lines = [
      `Charge ${charge.id} — ${refunds.length} refund(s) reçu(s).`,
      `Client : ${customerName || customerEmail || stripeCustomerId || 'N/A'}`,
      `Company matched : ${companyId || 'non'}`,
      `Factures créées : ${createdCount}, ignorées : ${skippedCount}`,
    ]
    for (const fid of insertedIds) {
      lines.push(`${appUrl}/erp/factures/${fid}`)
    }

    logSystemRun('sys_stripe_charge_refunded', {
      status: 'success',
      result: lines.join('\n'),
      duration_ms: Date.now() - started,
      triggerData: { charge_id: charge.id, refunds_count: refunds.length, created: createdCount },
    })

    return res.json({ received: true, created: createdCount, skipped: skippedCount, ids: insertedIds })
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

    console.log(`✅ Stripe ${event.type} ${invoice.id} → facture ${factureInfo?.action || 'no-op'}`)
    const appUrl = (process.env.APP_URL || 'https://customer.orisha.io').replace(/\/$/, '')
    const resultLines = [
      `${event.type} — facture Stripe ${invoice.number || invoice.id}`,
      `Client : ${customerName || customerEmail || 'N/A'}`,
      `Montant : ${((invoice.total || 0) / 100).toFixed(2)} ${(invoice.currency || 'cad').toUpperCase()}`,
      `Statut Stripe : ${invoice.status}`,
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
