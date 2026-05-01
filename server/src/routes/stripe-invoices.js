import { Router } from 'express'
import { randomUUID } from 'crypto'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import {
  getStripeClient,
  isGmailSendAvailable,
  buildInvoiceEmailHtml,
  createOrRefreshCheckoutSession,
} from '../services/stripeInvoices.js'
import { sendEmail } from '../services/gmail.js'

const router = Router()
router.use(requireAuth)

function appBaseUrl() {
  return (process.env.APP_URL || 'https://customer.orisha.io').replace(/\/$/, '')
}

function fmtMoney(n, currency = 'CAD') {
  try {
    return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: String(currency || 'CAD').toUpperCase() }).format(n)
  } catch { return `${Number(n).toFixed(2)} ${String(currency || 'CAD').toUpperCase()}` }
}

// ── Convertible soumissions / shipping resolver / soumission items (unchanged) ──

router.get('/companies/:companyId/convertible-soumissions', (req, res) => {
  const { companyId } = req.params
  const today = new Date().toISOString().slice(0, 10)
  const rows = db.prepare(`
    SELECT s.id, s.quote_number, s.title, s.status, s.expiration_date, s.created_at, s.currency,
           (SELECT COUNT(*) FROM document_items WHERE document_type='soumission' AND document_id=s.id) AS item_count,
           (SELECT COALESCE(SUM(qty * unit_price_cad), 0) FROM document_items WHERE document_type='soumission' AND document_id=s.id) AS subtotal
    FROM soumissions s
    WHERE s.company_id = ?
      AND s.status != 'Expirée'
      AND (s.expiration_date IS NULL OR date(s.expiration_date) >= date(?))
    ORDER BY s.created_at DESC
  `).all(companyId, today)
  res.json({ data: rows })
})

router.get('/soumissions/:id/items', (req, res) => {
  const items = db.prepare(`
    SELECT di.id, di.catalog_product_id AS product_id, di.qty, di.unit_price_cad AS unit_price,
           COALESCE(di.description_fr, di.description_en, p.name_fr, p.name_en, '') AS description,
           p.sku
    FROM document_items di
    LEFT JOIN products p ON p.id = di.catalog_product_id
    WHERE di.document_type = 'soumission' AND di.document_id = ?
    ORDER BY di.sort_order, di.id
  `).all(req.params.id)
  res.json({ data: items })
})

router.get('/companies/:companyId/shipping-province', (req, res) => {
  const row = db.prepare(`
    SELECT province, country, line1, city, postal_code
    FROM adresses
    WHERE company_id = ? AND address_type = 'Livraison' AND province IS NOT NULL AND province != ''
    ORDER BY created_at DESC
    LIMIT 1
  `).get(req.params.companyId)
  res.json(row || null)
})

// ── Pending invoices CRUD ───────────────────────────────────────────────────

// POST /api/stripe-invoices — create a pending_invoice (no Stripe call yet).
// If send_email=true, immediately creates a Checkout Session + emails the
// customer with the permanent /pay/:id link. Otherwise stays as draft.
//
// Optional overrides : email_to, email_subject, email_message — passés à
// sendInvoiceEmail pour personnaliser le destinataire / l'objet / le corps.
router.post('/', async (req, res) => {
  const started = Date.now()
  const {
    company_id, soumission_id, items,
    shipping_province, shipping_country,
    send_email, due_days,
    email_to, email_subject, email_message,
  } = req.body || {}

  if (!company_id) return res.status(400).json({ error: 'company_id requis' })
  if (!shipping_province) {
    return res.status(400).json({
      error: 'Aucune adresse de livraison avec province trouvée pour cette entreprise. Créez une adresse de livraison avant de générer une facture.',
      code: 'no_shipping_province',
    })
  }
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Au moins une ligne est requise' })

  const cleanItems = []
  for (const it of items) {
    const qty = Number(it.qty)
    const unit_price = Number(it.unit_price)
    if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: 'qty invalide' })
    if (!Number.isFinite(unit_price) || unit_price < 0) return res.status(400).json({ error: 'unit_price invalide' })
    const description = String(it.description || '').trim() || 'Article'
    cleanItems.push({ product_id: it.product_id || null, qty, unit_price, description })
  }

  const id = randomUUID()
  const days = Number.isFinite(Number(due_days)) && Number(due_days) > 0 ? Math.floor(Number(due_days)) : 30
  db.prepare(`
    INSERT INTO pending_invoices
      (id, company_id, soumission_id, currency, items_json,
       shipping_province, shipping_country, due_days, status, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, company_id, soumission_id || null, 'CAD',
    JSON.stringify(cleanItems),
    shipping_province, shipping_country || 'Canada',
    days, 'draft', req.user.id
  )

  let emailedTo = null, emailedFrom = null, emailMessageId = null
  let emailErr = null, emailSkippedReason = null
  let payUrl = `${appBaseUrl()}/erp/pay/${id}`
  let sessionUrl = null

  if (send_email) {
    if (!isGmailSendAvailable(req.user.id)) {
      emailSkippedReason = 'gmail_not_connected'
    } else {
      try {
        const sent = await sendInvoiceEmail({
          pendingId: id,
          userId: req.user.id,
          overrides: { to: email_to, subject: email_subject, message: email_message },
        })
        emailedTo = sent.emailedTo
        emailedFrom = sent.emailedFrom
        emailMessageId = sent.emailMessageId
        sessionUrl = sent.checkoutUrl
        db.prepare(`UPDATE pending_invoices SET status='sent', sent_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(id)
      } catch (e) {
        emailErr = e.message
      }
    }
  } else {
    emailSkippedReason = 'send_email=false'
  }

  res.json({
    ok: true,
    pending_invoice_id: id,
    status: send_email && !emailErr ? 'sent' : 'draft',
    pay_url: payUrl,
    checkout_session_url: sessionUrl,
    email: emailedTo
      ? { sent_to: emailedTo, from: emailedFrom, message_id: emailMessageId }
      : { sent: false, reason: emailErr || emailSkippedReason || null },
    duration_ms: Date.now() - started,
  })
})

// POST /api/stripe-invoices/:pendingId/send — send (or re-send) a pending
// invoice by email. Creates a Checkout Session if needed.
// Body optionnel : { to, subject, message } pour personnaliser l'envoi.
router.post('/:pendingId/send', async (req, res) => {
  const pending = db.prepare('SELECT * FROM pending_invoices WHERE id=?').get(req.params.pendingId)
  if (!pending) return res.status(404).json({ error: 'Pending invoice introuvable' })
  if (pending.status === 'paid') return res.status(400).json({ error: 'Déjà payée' })
  if (pending.status === 'cancelled') return res.status(400).json({ error: 'Annulée' })
  if (!isGmailSendAvailable(req.user.id)) {
    return res.status(400).json({ error: 'Aucun compte Gmail connecté pour votre utilisateur', code: 'gmail_not_connected' })
  }
  const { to, subject, message } = req.body || {}
  try {
    const sent = await sendInvoiceEmail({
      pendingId: pending.id,
      userId: req.user.id,
      overrides: { to, subject, message },
    })
    db.prepare(`UPDATE pending_invoices SET status='sent', sent_at=COALESCE(sent_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(pending.id)
    res.json({
      ok: true,
      pending_invoice_id: pending.id,
      pay_url: `${appBaseUrl()}/erp/pay/${pending.id}`,
      checkout_session_url: sent.checkoutUrl,
      email: { sent_to: sent.emailedTo, from: sent.emailedFrom, message_id: sent.emailMessageId },
    })
  } catch (e) {
    if (e.message === 'no_recipient_email') {
      return res.status(400).json({ error: "Aucune adresse email trouvée pour l'entreprise ou ses contacts", code: 'no_recipient_email' })
    }
    res.status(500).json({ error: e.message })
  }
})

// POST /api/stripe-invoices/:pendingId/cancel — mark pending as cancelled
router.post('/:pendingId/cancel', (req, res) => {
  const pending = db.prepare('SELECT id, status FROM pending_invoices WHERE id=?').get(req.params.pendingId)
  if (!pending) return res.status(404).json({ error: 'Introuvable' })
  if (pending.status === 'paid') return res.status(400).json({ error: 'Déjà payée — ne peut pas être annulée' })
  db.prepare(`UPDATE pending_invoices SET status='cancelled', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(pending.id)
  res.json({ ok: true })
})

// GET /api/stripe-invoices/pending/:pendingId — full read for FactureDetail
router.get('/pending/:pendingId', (req, res) => {
  const row = db.prepare(`
    SELECT p.*, c.name AS company_name
    FROM pending_invoices p
    LEFT JOIN companies c ON p.company_id = c.id
    WHERE p.id = ?
  `).get(req.params.pendingId)
  if (!row) return res.status(404).json({ error: 'Introuvable' })
  res.json({
    ...row,
    items: JSON.parse(row.items_json || '[]'),
    pay_url: `${appBaseUrl()}/erp/pay/${row.id}`,
  })
})

// ── Helper: defaults for the send-email modal ──────────────────────────────

function resolveDefaultRecipient(companyId) {
  const co = db.prepare('SELECT email FROM companies WHERE id=?').get(companyId)
  const ct = db.prepare(`
    SELECT id, email, first_name FROM contacts
    WHERE company_id=? AND email IS NOT NULL AND email!=''
    ORDER BY created_at LIMIT 1
  `).get(companyId)
  return {
    email: co?.email || ct?.email || null,
    contactFirstName: ct?.first_name || null,
    contactId: ct?.id || null,
  }
}

function buildDefaultMessage({ contactFirstName, totalLabel, dueDateLabel }) {
  const greeting = contactFirstName ? `Bonjour ${contactFirstName},` : 'Bonjour,'
  const intro = `Vous trouverez ci-dessous le lien de paiement pour la facture au montant de ${totalLabel}${dueDateLabel ? `, payable au plus tard ${dueDateLabel}` : ''}.`
  return `${greeting}\n\n${intro}`
}

function buildPendingTotalLabel(pending) {
  const items = JSON.parse(pending.items_json || '[]')
  const subtotal = items.reduce((s, it) => s + Number(it.qty) * Number(it.unit_price), 0)
  return fmtMoney(subtotal, pending.currency || 'CAD') + ' (avant taxes)'
}

// GET /api/stripe-invoices/:pendingId/email-defaults — pré-remplit la modale d'envoi
router.get('/:pendingId/email-defaults', (req, res) => {
  const pending = db.prepare('SELECT * FROM pending_invoices WHERE id=?').get(req.params.pendingId)
  if (!pending) return res.status(404).json({ error: 'Introuvable' })

  const { email: defaultEmail, contactFirstName } = resolveDefaultRecipient(pending.company_id)
  const company = db.prepare('SELECT id, name, email FROM companies WHERE id=?').get(pending.company_id)
  const contacts = db.prepare(`
    SELECT id, first_name, last_name, email FROM contacts
    WHERE company_id=? AND email IS NOT NULL AND email!=''
    ORDER BY created_at
  `).all(pending.company_id)

  const totalLabel = buildPendingTotalLabel(pending)
  const dueDateLabel = pending.due_days ? `${pending.due_days} jours après émission` : null

  res.json({
    pending_invoice_id: pending.id,
    company: company ? { id: company.id, name: company.name, email: company.email || null } : null,
    contacts: contacts.map(c => ({
      id: c.id,
      name: [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email,
      email: c.email,
    })),
    defaults: {
      to: defaultEmail,
      subject: `Facture Orisha — ${totalLabel}`,
      message: buildDefaultMessage({ contactFirstName, totalLabel, dueDateLabel }),
    },
    total_label: totalLabel,
    due_date_label: dueDateLabel,
  })
})

// ── Helper: build + send the email ─────────────────────────────────────────

// Resolves recipient (companies.email or first contact, sauf override).
// Creates/refreshes a Checkout Session for the /pay link, builds the email
// HTML + tracking pixel, sends via Gmail, logs interaction + email.
async function sendInvoiceEmail({ pendingId, userId, overrides }) {
  const stripe = getStripeClient()
  const pending = db.prepare('SELECT * FROM pending_invoices WHERE id=?').get(pendingId)
  if (!pending) throw new Error('pending_not_found')

  // Pre-create the Checkout Session so the email link works on first click
  const { url: checkoutUrl } = await createOrRefreshCheckoutSession({
    stripe, pending, baseAppUrl: appBaseUrl(),
  })

  const { email: defaultEmail, contactFirstName, contactId: defaultContactId } = resolveDefaultRecipient(pending.company_id)

  const overrideTo = overrides?.to ? String(overrides.to).trim() : null
  let recipientEmail = overrideTo || defaultEmail
  if (!recipientEmail) throw new Error('no_recipient_email')

  // Si le destinataire override correspond à un contact existant, on l'attache.
  let recipientContactId = defaultContactId
  if (overrideTo) {
    const matchedContact = db.prepare(
      `SELECT id FROM contacts WHERE company_id=? AND lower(email)=lower(?) LIMIT 1`
    ).get(pending.company_id, overrideTo)
    recipientContactId = matchedContact?.id || null
  }

  const totalLabel = buildPendingTotalLabel(pending)
  const dueDateLabel = pending.due_days ? `${pending.due_days} jours après émission` : null

  const interactionId = randomUUID()
  const emailRowId = randomUUID()
  const ts = new Date().toISOString()
  const subject = (overrides?.subject && String(overrides.subject).trim()) || `Facture Orisha — ${totalLabel}`

  const trackingPixelUrl = `${appBaseUrl()}/erp/api/email-tracking/${emailRowId}.gif`
  const userRow = db.prepare('SELECT name FROM users WHERE id=?').get(userId)
  // Use the permanent /pay/:id link in the email so it always works even
  // after the underlying Checkout Session expires.
  const payUrl = `${appBaseUrl()}/erp/pay/${pending.id}`

  const html = buildInvoiceEmailHtml({
    contactFirstName,
    invoiceNumber: '', // not assigned yet — Stripe will assign at payment
    hostedUrl: payUrl,
    pdfUrl: null,
    totalLabel,
    dueDateLabel,
    trackingPixelUrl,
    fromName: userRow?.name || 'Orisha',
    customMessage: overrides?.message || null,
  })

  const sent = await sendEmail(recipientEmail, subject, html, { userId })

  db.prepare(`INSERT INTO interactions (id, contact_id, company_id, user_id, type, direction, timestamp)
    VALUES (?,?,?,?,'email','out',?)`)
    .run(interactionId, recipientContactId, pending.company_id, userId, ts)
  db.prepare(`INSERT INTO emails (id, interaction_id, subject, body_html, from_address, to_address, gmail_message_id, gmail_thread_id, automated, open_count)
    VALUES (?,?,?,?,?,?,?,?,0,0)`)
    .run(emailRowId, interactionId, subject, html, sent.account_email, recipientEmail, sent.message_id, sent.thread_id || null)

  return {
    emailedTo: recipientEmail,
    emailedFrom: sent.account_email,
    emailMessageId: sent.message_id,
    checkoutUrl,
  }
}

export default router
