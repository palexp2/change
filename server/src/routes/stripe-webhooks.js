import { Router } from 'express'
import { randomUUID } from 'crypto'
import Stripe from 'stripe'
import db from '../db/database.js'

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

// Resolve company by email or name
function findCompanyByEmail(email) {
  if (!email) return null
  const byContact = db.prepare(`
    SELECT c.id FROM companies c
    INNER JOIN contacts ct ON ct.company_id = c.id
    WHERE LOWER(ct.email)=LOWER(?)
    LIMIT 1
  `).get(email)
  if (byContact) return byContact.id

  const byCompany = db.prepare(
    "SELECT id FROM companies WHERE LOWER(email)=LOWER(?) LIMIT 1"
  ).get(email)
  return byCompany?.id || null
}

function findCompanyByName(name) {
  if (!name) return null
  const row = db.prepare(
    "SELECT id FROM companies WHERE name LIKE ? LIMIT 1"
  ).get(`%${name}%`)
  return row?.id || null
}

// POST /api/stripe-webhooks and POST /api/stripe-webhooks/:legacy (backward compat with Stripe dashboard)
async function handleWebhook(req, res) {
  const secretKey = getStripeKey()
  if (!secretKey) return res.status(400).json({ error: 'Stripe non configuré' })

  const webhookSecret = getWebhookSecret()
  let event

  if (webhookSecret) {
    const sig = req.headers['stripe-signature']
    try {
      const stripe = new Stripe(secretKey)
      event = stripe.webhooks.constructEvent(req.rawBody, sig, webhookSecret)
    } catch (err) {
      console.error('Stripe webhook signature verification failed:', err.message)
      return res.status(400).json({ error: 'Signature invalide' })
    }
  } else {
    // No webhook secret configured — accept raw payload (dev mode)
    event = req.body
  }

  if (event.type !== 'invoice.paid') {
    return res.json({ received: true, ignored: true })
  }

  const invoice = event.data.object

  try {
    // Check for duplicate
    const existing = db.prepare(
      'SELECT id FROM stripe_invoice_queue WHERE stripe_invoice_id=?'
    ).get(invoice.id)
    if (existing) return res.json({ received: true, duplicate: true })

    // Extract customer info
    const customerName = invoice.customer_name || invoice.customer_email || null
    const customerEmail = invoice.customer_email || null
    const companyId = findCompanyByEmail(customerEmail)
      || findCompanyByName(customerName)

    // Extract line items
    const lineItems = (invoice.lines?.data || []).map(line => ({
      description: line.description || line.plan?.nickname || 'Article',
      amount: line.amount || 0,
      quantity: line.quantity || 1,
      tax_amounts: (line.tax_amounts || []).map(ta => ({
        amount: ta.amount,
        tax_rate_id: ta.tax_rate,
        inclusive: ta.inclusive,
      })),
    }))

    // Extract tax details
    const taxDetails = (invoice.total_tax_amounts || []).map(ta => ({
      amount: ta.amount,
      tax_rate_id: typeof ta.tax_rate === 'string' ? ta.tax_rate : ta.tax_rate?.id,
      inclusive: ta.inclusive,
    }))

    // Calculate Stripe fee from charge
    let stripeFee = 0
    if (invoice.charge) {
      try {
        const stripe = new Stripe(secretKey)
        const charge = await stripe.charges.retrieve(invoice.charge, {
          expand: ['balance_transaction'],
        })
        stripeFee = charge.balance_transaction?.fee || 0
      } catch (e) {
        console.error('Could not fetch Stripe fee:', e.message)
      }
    }

    // Look up tax mapping
    let qbTaxCode = null
    if (taxDetails.length > 0) {
      const taxRateId = taxDetails[0].tax_rate_id
      if (taxRateId) {
        const mapping = db.prepare(
          'SELECT qb_tax_code FROM stripe_qb_tax_mapping WHERE stripe_tax_id=?'
        ).get(taxRateId)
        if (mapping) qbTaxCode = mapping.qb_tax_code
      }
    }

    const id = randomUUID()
    db.prepare(`
      INSERT INTO stripe_invoice_queue
        (id, stripe_invoice_id, stripe_customer_id, customer_name, customer_email,
         company_id, invoice_number, invoice_date, currency, subtotal, tax_amount, total,
         stripe_fee, line_items, tax_details, status, qb_tax_code, stripe_raw)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id, invoice.id,
      typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id,
      customerName, customerEmail, companyId,
      invoice.number || null,
      invoice.created ? new Date(invoice.created * 1000).toISOString().slice(0, 10) : null,
      (invoice.currency || 'cad').toUpperCase(),
      invoice.subtotal || 0,
      invoice.tax || 0,
      invoice.total || 0,
      stripeFee,
      JSON.stringify(lineItems),
      JSON.stringify(taxDetails),
      'pending',
      qbTaxCode,
      JSON.stringify(invoice)
    )

    // Also update/create in factures table
    try {
      const total = (invoice.total || 0) / 100
      const subtotal = (invoice.subtotal || 0) / 100
      const balanceDue = (invoice.amount_remaining || 0) / 100
      const currency = (invoice.currency || 'cad').toUpperCase()
      const invoiceDate = invoice.created ? new Date(invoice.created * 1000).toISOString().slice(0, 10) : null

      // Resolve subscription
      let subscriptionId = null
      const stripeSub = typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id
      if (stripeSub) {
        const subRow = db.prepare('SELECT id FROM subscriptions WHERE stripe_id=?').get(stripeSub)
        if (subRow) subscriptionId = subRow.id
      }

      const existingFacture = db.prepare("SELECT id FROM factures WHERE invoice_id=?").get(invoice.id)
      if (existingFacture) {
        db.prepare(`
          UPDATE factures SET
            status='Payé', total_amount=?, amount_before_tax_cad=?, balance_due=0,
            currency=?, document_date=COALESCE(document_date,?),
            document_number=COALESCE(document_number,?),
            subscription_id=COALESCE(subscription_id,?), company_id=COALESCE(company_id,?),
            sync_source='Factures Stripe', updated_at=datetime('now')
          WHERE id=?
        `).run(total, subtotal, currency, invoiceDate, invoice.number || null,
          subscriptionId, companyId, existingFacture.id)
      } else {
        db.prepare(`
          INSERT INTO factures (id, invoice_id, company_id, document_number, document_date,
            status, currency, amount_before_tax_cad, total_amount, balance_due,
            subscription_id, sync_source, created_at, updated_at)
          VALUES (?,?,?,?,?,'Payé',?,?,?,0,?,'Factures Stripe',datetime('now'),datetime('now'))
        `).run(randomUUID(), invoice.id, companyId, invoice.number || null, invoiceDate,
          currency, subtotal, total, subscriptionId)
      }
    } catch (factureErr) {
      console.error('Could not update factures table:', factureErr.message)
    }

    console.log(`✅ Stripe invoice ${invoice.id} queued + facture synced`)
    res.json({ received: true, queued: true, id })
  } catch (err) {
    console.error('Stripe webhook processing error:', err.message)
    res.status(500).json({ error: err.message })
  }
}

router.post('/', handleWebhook)
router.post('/:legacy', handleWebhook)

export default router
