import db from '../db/database.js'
import Stripe from 'stripe'

function getStripeKey() {
  const row = db.prepare("SELECT value FROM connector_config WHERE connector='stripe' AND key='secret_key'").get()
  return row?.value || null
}

export function getStripeClient() {
  const sk = getStripeKey()
  if (!sk) throw new Error('Stripe non configuré')
  return new Stripe(sk)
}

// Returns the existing stripe_customer_id for the company, or creates one
// in Stripe (with name + email + erp_company_id metadata) and stores it.
export async function ensureStripeCustomer(stripe, companyId) {
  const co = db.prepare(
    'SELECT id, name, email, stripe_customer_id FROM companies WHERE id=?'
  ).get(companyId)
  if (!co) throw new Error('Entreprise introuvable')
  if (co.stripe_customer_id) return co.stripe_customer_id

  // Try the primary contact's email if the company itself has none
  let email = co.email
  if (!email) {
    const ct = db.prepare(
      "SELECT email FROM contacts WHERE company_id=? AND email IS NOT NULL AND email!='' ORDER BY created_at LIMIT 1"
    ).get(companyId)
    email = ct?.email || null
  }

  const created = await stripe.customers.create({
    name: co.name,
    email: email || undefined,
    metadata: { erp_company_id: co.id },
  })
  db.prepare('UPDATE companies SET stripe_customer_id=?, updated_at=strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\') WHERE id=?')
    .run(created.id, companyId)
  return created.id
}

// Get/create a Stripe tax_rate matching {name, percentage, jurisdiction}.
// Cached in connector_config so we create each rate exactly once.
export async function getOrCreateTaxRate(stripe, { name, percentage, jurisdiction }) {
  const cacheKey = `tax_rate_${jurisdiction}_${name}_${percentage}`
  const existing = db.prepare(
    "SELECT value FROM connector_config WHERE connector='stripe' AND key=?"
  ).get(cacheKey)
  if (existing?.value) return existing.value

  const created = await stripe.taxRates.create({
    display_name: name,
    inclusive: false,
    percentage,
    jurisdiction,
    country: jurisdiction.startsWith('CA') ? 'CA' : undefined,
    state: jurisdiction.startsWith('CA-') ? jurisdiction.slice(3) : undefined,
  })
  db.prepare(`
    INSERT INTO connector_config (connector, key, value) VALUES ('stripe', ?, ?)
    ON CONFLICT(connector, key) DO UPDATE SET value=excluded.value
  `).run(cacheKey, created.id)
  return created.id
}

// Build line_items for Stripe Checkout Session from a pending_invoice's items_json.
// Each item gets the right tax_rates attached based on shipping province/country.
async function buildCheckoutLineItems(stripe, { items, shipping_province, shipping_country }) {
  const { computeCanadaTaxes } = await import('./taxes.js')
  const subtotal = items.reduce((s, it) => s + Number(it.qty) * Number(it.unit_price), 0)
  const taxes = computeCanadaTaxes({ province: shipping_province, country: shipping_country, subtotal })
  const taxRateIds = []
  for (const t of taxes) {
    const id = await getOrCreateTaxRate(stripe, { name: t.name, percentage: t.percentage, jurisdiction: t.jurisdiction })
    taxRateIds.push(id)
  }
  return items.map(it => ({
    quantity: Number(it.qty),
    price_data: {
      currency: 'cad',
      unit_amount_decimal: String(Math.round(Number(it.unit_price) * 100)),
      product_data: {
        name: String(it.description || 'Article').slice(0, 250),
        ...(it.product_id ? { metadata: { erp_product_id: it.product_id } } : {}),
      },
    },
    ...(taxRateIds.length > 0 ? { tax_rates: taxRateIds } : {}),
  }))
}

// Create or refresh a Stripe Checkout Session for a pending_invoice.
// Idempotent in the sense that an unexpired existing session is reused; expired
// or missing → new one created. The customer-facing /pay/:pendingId URL relies
// on this so the link stays "permanent" even after Stripe sessions expire.
//
// Returns { sessionId, url, expiresAt }.
export async function createOrRefreshCheckoutSession({ stripe, pending, baseAppUrl }) {
  const { default: db } = await import('../db/database.js')

  // Reuse the current session if still valid + same items
  if (pending.last_session_id && pending.last_session_expires_at) {
    const expiresAt = Date.parse(pending.last_session_expires_at)
    if (expiresAt > Date.now() + 60_000) {
      // Verify on Stripe that it's still open
      try {
        const cur = await stripe.checkout.sessions.retrieve(pending.last_session_id)
        if (cur.status === 'open' && cur.payment_status !== 'paid') {
          return { sessionId: cur.id, url: cur.url, expiresAt: new Date(cur.expires_at * 1000).toISOString() }
        }
      } catch { /* fall through and create a new one */ }
    }
  }

  // Resolve customer (may auto-create)
  const customerId = await ensureStripeCustomer(stripe, pending.company_id)

  const items = JSON.parse(pending.items_json || '[]')
  const line_items = await buildCheckoutLineItems(stripe, {
    items,
    shipping_province: pending.shipping_province,
    shipping_country: pending.shipping_country,
  })

  const successUrl = `${baseAppUrl}/erp/customer/post-payment?session_id={CHECKOUT_SESSION_ID}`
  const cancelUrl = `${baseAppUrl}/erp/pay/${pending.id}?cancelled=1`

  // Stripe max expires_at is 24h for hosted Checkout Sessions. Beyond that the
  // /pay endpoint creates a fresh one.
  const expiresAt = Math.floor(Date.now() / 1000) + 23 * 3600

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer: customerId,
    line_items,
    success_url: successUrl,
    cancel_url: cancelUrl,
    expires_at: expiresAt,
    invoice_creation: {
      enabled: true,
      invoice_data: {
        metadata: {
          erp_pending_invoice_id: pending.id,
          erp_company_id: pending.company_id || '',
          ...(pending.soumission_id ? { erp_soumission_id: pending.soumission_id } : {}),
        },
        ...(pending.due_days ? { custom_fields: [{ name: 'Échéance', value: `${pending.due_days} jours` }] } : {}),
      },
    },
    metadata: {
      erp_pending_invoice_id: pending.id,
      erp_company_id: pending.company_id || '',
    },
  })

  db.prepare(`
    UPDATE pending_invoices
    SET last_session_id=?, last_session_url=?, last_session_expires_at=?,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=?
  `).run(session.id, session.url, new Date(session.expires_at * 1000).toISOString(), pending.id)

  return { sessionId: session.id, url: session.url, expiresAt: new Date(session.expires_at * 1000).toISOString() }
}

// Returns true if at least one Google OAuth connection has the gmail.send
// scope (or a refresh_token allowing a refresh into the right scope).
export function isGmailSendAvailable(userId) {
  if (userId) {
    const row = db.prepare(`
      SELECT co.id FROM connector_oauth co
      JOIN users u ON lower(u.email) = lower(co.account_email)
      WHERE co.connector='google' AND co.refresh_token IS NOT NULL AND u.id=?
      LIMIT 1
    `).get(userId)
    if (row) return true
  }
  const any = db.prepare(
    "SELECT id FROM connector_oauth WHERE connector='google' AND refresh_token IS NOT NULL LIMIT 1"
  ).get()
  return !!any
}

// Build the HTML body of the invoice email. Includes the Stripe hosted-invoice link
// and a 1×1 tracking pixel pointing at /api/email-tracking/:emailId.gif.
export function buildInvoiceEmailHtml({
  contactFirstName,
  invoiceNumber,
  hostedUrl,
  pdfUrl,
  totalLabel,
  dueDateLabel,
  trackingPixelUrl,
  fromName,
}) {
  const greeting = contactFirstName ? `Bonjour ${escapeHtml(contactFirstName)},` : 'Bonjour,'
  return `<!DOCTYPE html>
<html><body style="font-family:Arial,sans-serif;color:#1f2937;line-height:1.5;">
<p>${greeting}</p>
<p>Vous trouverez ci-jointe la facture <strong>${escapeHtml(invoiceNumber || '')}</strong> au montant de <strong>${escapeHtml(totalLabel || '')}</strong>${dueDateLabel ? `, payable au plus tard le <strong>${escapeHtml(dueDateLabel)}</strong>` : ''}.</p>
<p><a href="${escapeAttr(hostedUrl)}" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 16px;text-decoration:none;border-radius:6px;font-weight:600;">Voir et payer la facture</a></p>
${pdfUrl ? `<p><a href="${escapeAttr(pdfUrl)}">Télécharger le PDF</a></p>` : ''}
<p>Merci pour votre confiance,<br/>${escapeHtml(fromName || 'Orisha')}</p>
${trackingPixelUrl ? `<img src="${escapeAttr(trackingPixelUrl)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;" />` : ''}
</body></html>`
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
function escapeAttr(s) { return escapeHtml(s) }

function formatMoney(n, currency = 'CAD') {
  try {
    return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: String(currency || 'CAD').toUpperCase() }).format(n)
  } catch { return `${Number(n).toFixed(2)} ${String(currency || 'CAD').toUpperCase()}` }
}

// Finalize a draft invoice in Stripe and send the email via Gmail. Idempotent
// in the sense that it can be called on an already-finalized invoice (will skip
// finalize + still send email if not already sent).
//
// Resolves recipient from companies.email or first contact email.
// Inserts an interaction + emails row with a tracking pixel URL.
//
// Returns { invoice, emailedTo, emailedFrom, emailMessageId, emailErr }.
export async function finalizeAndSendInvoice({ stripe, stripeInvoiceId, companyId, userId }) {
  const { sendEmail } = await import('./gmail.js')
  const { randomUUID } = await import('crypto')

  if (!isGmailSendAvailable(userId)) {
    throw new Error('gmail_not_connected')
  }

  // Resolve recipient
  let recipientEmail = null
  let recipientFirstName = null
  let recipientContactId = null
  const co = db.prepare('SELECT email FROM companies WHERE id=?').get(companyId)
  if (co?.email) recipientEmail = co.email
  const ct = db.prepare(`
    SELECT id, email, first_name FROM contacts
    WHERE company_id=? AND email IS NOT NULL AND email!=''
    ORDER BY created_at LIMIT 1
  `).get(companyId)
  if (!recipientEmail && ct?.email) recipientEmail = ct.email
  if (ct?.first_name) recipientFirstName = ct.first_name
  if (ct?.id) recipientContactId = ct.id
  if (!recipientEmail) throw new Error('no_recipient_email')

  // Fetch + finalize if still draft
  let invoice = await stripe.invoices.retrieve(stripeInvoiceId)
  if (invoice.status === 'draft') {
    invoice = await stripe.invoices.finalizeInvoice(stripeInvoiceId, { auto_advance: false })
  }

  // Build email
  const interactionId = randomUUID()
  const emailRowId = randomUUID()
  const ts = new Date().toISOString()
  const total = (invoice.total || 0) / 100
  const totalLabel = formatMoney(total, invoice.currency)
  const dueDateLabel = invoice.due_date ? new Date(invoice.due_date * 1000).toLocaleDateString('fr-CA') : null
  const subject = `Facture ${invoice.number || ''} — ${totalLabel}`
  const baseUrl = (process.env.APP_URL || 'https://customer.orisha.io').replace(/\/$/, '')
  const trackingPixelUrl = `${baseUrl}/erp/api/email-tracking/${emailRowId}.gif`
  const userRow = db.prepare('SELECT name FROM users WHERE id=?').get(userId)
  const html = buildInvoiceEmailHtml({
    contactFirstName: recipientFirstName,
    invoiceNumber: invoice.number || invoice.id,
    hostedUrl: invoice.hosted_invoice_url,
    pdfUrl: invoice.invoice_pdf,
    totalLabel,
    dueDateLabel,
    trackingPixelUrl,
    fromName: userRow?.name || 'Orisha',
  })

  const sent = await sendEmail(recipientEmail, subject, html, { userId })

  // Log interaction + email row
  db.prepare(`INSERT INTO interactions (id, contact_id, company_id, user_id, type, direction, timestamp)
    VALUES (?,?,?,?,'email','out',?)`)
    .run(interactionId, recipientContactId, companyId, userId, ts)
  db.prepare(`INSERT INTO emails (id, interaction_id, subject, body_html, from_address, to_address, gmail_message_id, gmail_thread_id, automated, open_count)
    VALUES (?,?,?,?,?,?,?,?,0,0)`)
    .run(emailRowId, interactionId, subject, html, sent.account_email, recipientEmail, sent.message_id, sent.thread_id || null)

  return {
    invoice,
    emailedTo: recipientEmail,
    emailedFrom: sent.account_email,
    emailMessageId: sent.message_id,
  }
}
