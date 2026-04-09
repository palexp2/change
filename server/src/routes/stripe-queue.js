import { Router } from 'express'
import { randomUUID } from 'crypto'
import Stripe from 'stripe'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { pushStripeInvoiceToQB } from '../services/quickbooks.js'

function getStripeKey() {
  const row = db.prepare(
    "SELECT value FROM connector_config WHERE connector='stripe' AND key='secret_key'"
  ).get()
  return row?.value || null
}

function findCompanyByEmail(email) {
  if (!email) return null
  const byContact = db.prepare(`
    SELECT c.id FROM companies c
    INNER JOIN contacts ct ON ct.company_id = c.id
    WHERE LOWER(ct.email)=LOWER(?) LIMIT 1
  `).get(email)
  if (byContact) return byContact.id
  const byCompany = db.prepare(
    "SELECT id FROM companies WHERE LOWER(email)=LOWER(?) LIMIT 1"
  ).get(email)
  return byCompany?.id || null
}

function findCompanyByName(name) {
  if (!name) return null
  const row = db.prepare("SELECT id FROM companies WHERE name LIKE ? LIMIT 1").get(`%${name}%`)
  return row?.id || null
}

function mapStripeStatus(stripeStatus) {
  const map = {
    paid: 'Payé',
    open: 'À payer',
    void: 'Void',
    uncollectible: 'Uncollectible',
    draft: 'Draft',
  }
  return map[stripeStatus] || stripeStatus
}

const router = Router()
router.use(requireAuth)

// GET /api/stripe-queue — list all queued invoices
router.get('/', (req, res) => {
  const { status, page = 1, limit = 50 } = req.query
  const offset = (parseInt(page) - 1) * parseInt(limit)

  let where = ''
  const params = []
  if (status) {
    where = 'WHERE status=?'
    params.push(status)
  }

  const total = db.prepare(`SELECT COUNT(*) as c FROM stripe_invoice_queue ${where}`).get(...params).c
  const rows = db.prepare(`
    SELECT sq.*, c.name as company_name
    FROM stripe_invoice_queue sq
    LEFT JOIN companies c ON sq.company_id = c.id
    ${where ? where.replace('WHERE status', 'WHERE sq.status') : ''}
    ORDER BY sq.created_at DESC LIMIT ? OFFSET ?
  `).all(...params, parseInt(limit), offset)

  const parsed = rows.map(r => ({
    ...r,
    line_items: JSON.parse(r.line_items || '[]'),
    tax_details: JSON.parse(r.tax_details || '[]'),
  }))

  res.json({ data: parsed, total, page: parseInt(page), limit: parseInt(limit) })
})

// GET /api/stripe-queue/:id — get single invoice detail
router.get('/:id', (req, res) => {
  const row = db.prepare(
    'SELECT * FROM stripe_invoice_queue WHERE id=?'
  ).get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Introuvable' })
  res.json({
    ...row,
    line_items: JSON.parse(row.line_items || '[]'),
    tax_details: JSON.parse(row.tax_details || '[]'),
  })
})

// PATCH /api/stripe-queue/:id — update fields before approval
router.patch('/:id', (req, res) => {
  const row = db.prepare(
    'SELECT * FROM stripe_invoice_queue WHERE id=?'
  ).get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Introuvable' })
  if (row.status === 'pushed') return res.status(400).json({ error: 'Déjà publié sur QuickBooks' })

  const allowed = ['company_id', 'qb_customer_id', 'qb_income_account_id', 'qb_deposit_account_id', 'qb_tax_code', 'customer_name']
  const updates = []
  const values = []
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      updates.push(`${key}=?`)
      values.push(req.body[key])
    }
  }

  if (updates.length === 0) return res.json(row)

  updates.push("updated_at=datetime('now')")
  values.push(req.params.id)

  db.prepare(`UPDATE stripe_invoice_queue SET ${updates.join(', ')} WHERE id=?`).run(...values)
  const updated = db.prepare('SELECT * FROM stripe_invoice_queue WHERE id=?').get(req.params.id)
  res.json({
    ...updated,
    line_items: JSON.parse(updated.line_items || '[]'),
    tax_details: JSON.parse(updated.tax_details || '[]'),
  })
})

// POST /api/stripe-queue/:id/approve — approve and push to QB
router.post('/:id/approve', async (req, res) => {
  const row = db.prepare(
    'SELECT * FROM stripe_invoice_queue WHERE id=?'
  ).get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Introuvable' })
  if (row.status === 'pushed') return res.status(400).json({ error: 'Déjà publié sur QuickBooks' })

  // Accept optional overrides in body
  const { qb_customer_id, qb_income_account_id, qb_deposit_account_id } = req.body
  if (qb_customer_id || qb_income_account_id || qb_deposit_account_id) {
    const fields = []
    const vals = []
    if (qb_customer_id) { fields.push('qb_customer_id=?'); vals.push(qb_customer_id) }
    if (qb_income_account_id) { fields.push('qb_income_account_id=?'); vals.push(qb_income_account_id) }
    if (qb_deposit_account_id) { fields.push('qb_deposit_account_id=?'); vals.push(qb_deposit_account_id) }
    vals.push(req.params.id)
    db.prepare(`UPDATE stripe_invoice_queue SET ${fields.join(', ')} WHERE id=?`).run(...vals)
  }

  db.prepare("UPDATE stripe_invoice_queue SET status='approved', updated_at=datetime('now') WHERE id=?").run(req.params.id)

  try {
    const qbId = await pushStripeInvoiceToQB(req.params.id)
    res.json({ ok: true, quickbooks_id: qbId })
  } catch (e) {
    db.prepare("UPDATE stripe_invoice_queue SET status='error', error_message=?, updated_at=datetime('now') WHERE id=?")
      .run(e.message, req.params.id)
    res.status(400).json({ error: e.message })
  }
})

// POST /api/stripe-queue/:id/reject — reject an invoice
router.post('/:id/reject', (req, res) => {
  const row = db.prepare(
    'SELECT id, status FROM stripe_invoice_queue WHERE id=?'
  ).get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Introuvable' })
  if (row.status === 'pushed') return res.status(400).json({ error: 'Déjà publié sur QuickBooks' })

  db.prepare("UPDATE stripe_invoice_queue SET status='rejected', updated_at=datetime('now') WHERE id=?")
    .run(req.params.id)
  res.json({ ok: true })
})

// POST /api/stripe-queue/:id/reset — reset to pending
router.post('/:id/reset', (req, res) => {
  const row = db.prepare(
    'SELECT id, status FROM stripe_invoice_queue WHERE id=?'
  ).get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Introuvable' })
  if (row.status === 'pushed') return res.status(400).json({ error: 'Déjà publié sur QuickBooks' })

  db.prepare("UPDATE stripe_invoice_queue SET status='pending', error_message=NULL, updated_at=datetime('now') WHERE id=?")
    .run(req.params.id)
  res.json({ ok: true })
})

// GET /api/stripe-queue/tax-rates — unique tax rate IDs from queued invoices
router.get('/tax-rates/unique', (req, res) => {
  const rows = db.prepare(
    "SELECT tax_details FROM stripe_invoice_queue WHERE tax_details IS NOT NULL AND tax_details != '[]'"
  ).all()
  const seen = new Map()
  for (const row of rows) {
    const details = JSON.parse(row.tax_details || '[]')
    for (const t of details) {
      if (t.tax_rate_id && !seen.has(t.tax_rate_id)) {
        seen.set(t.tax_rate_id, {
          stripe_tax_id: t.tax_rate_id,
          percentage: t.percentage || null,
        })
      }
    }
  }
  res.json([...seen.values()])
})

// GET /api/stripe-queue/tax-mappings — list tax mappings
router.get('/tax-mappings/list', (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM stripe_qb_tax_mapping ORDER BY created_at'
  ).all()
  res.json(rows)
})

// POST /api/stripe-queue/tax-mappings — create/update tax mapping
router.post('/tax-mappings', (req, res) => {
  const { stripe_tax_id, stripe_tax_description, qb_tax_code } = req.body
  if (!stripe_tax_id || !qb_tax_code) {
    return res.status(400).json({ error: 'stripe_tax_id et qb_tax_code requis' })
  }

  const existing = db.prepare(
    'SELECT id FROM stripe_qb_tax_mapping WHERE stripe_tax_id=?'
  ).get(stripe_tax_id)

  if (existing) {
    db.prepare(
      'UPDATE stripe_qb_tax_mapping SET qb_tax_code=?, stripe_tax_description=? WHERE id=?'
    ).run(qb_tax_code, stripe_tax_description || null, existing.id)
    res.json({ ok: true, id: existing.id })
  } else {
    const id = randomUUID()
    db.prepare(`
      INSERT INTO stripe_qb_tax_mapping (id, stripe_tax_id, stripe_tax_description, qb_tax_code)
      VALUES (?,?,?,?)
    `).run(id, stripe_tax_id, stripe_tax_description || null, qb_tax_code)
    res.json({ ok: true, id })
  }
})

// DELETE /api/stripe-queue/tax-mappings/:id
router.delete('/tax-mappings/:id', (req, res) => {
  db.prepare('DELETE FROM stripe_qb_tax_mapping WHERE id=?')
    .run(req.params.id)
  res.json({ ok: true })
})

// POST /api/stripe-queue/batch-enrich — fetch all Stripe invoices, update factures table
let batchRunning = false
let batchProgress = { running: false, total: 0, processed: 0, updated: 0, created: 0, skipped: 0, errors: [] }

router.get('/batch-enrich/status', (req, res) => {
  res.json(batchProgress)
})

router.post('/batch-enrich', async (req, res) => {
  if (batchRunning) return res.status(409).json({ error: 'Batch déjà en cours', progress: batchProgress })

  const secretKey = getStripeKey()
  if (!secretKey) return res.status(400).json({ error: 'Stripe non configuré' })

  batchRunning = true
  batchProgress = { running: true, total: 0, processed: 0, updated: 0, created: 0, skipped: 0, errors: [] }

  // Respond immediately — processing happens in background
  res.json({ ok: true, message: 'Batch démarré' })

  const stripe = new Stripe(secretKey)

  try {
    // Paginate all invoices
    const allInvoices = []
    for await (const inv of stripe.invoices.list({ limit: 100, expand: ['data.charge'] })) {
      allInvoices.push(inv)
    }
    batchProgress.total = allInvoices.length
    console.log(`📥 Batch Stripe: ${allInvoices.length} factures récupérées`)

    const updateStmt = db.prepare(`
      UPDATE factures SET
        status=?, total_amount=?, amount_before_tax_cad=?, balance_due=?,
        currency=?, document_date=?, document_number=COALESCE(document_number,?),
        subscription_id=COALESCE(subscription_id,?), company_id=COALESCE(company_id,?),
        sync_source='Factures Stripe', updated_at=datetime('now')
      WHERE invoice_id=?
    `)

    const insertStmt = db.prepare(`
      INSERT INTO factures (id, invoice_id, company_id, document_number, document_date,
        status, currency, amount_before_tax_cad, total_amount, balance_due,
        subscription_id, sync_source, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'Factures Stripe',datetime('now'),datetime('now'))
    `)

    for (const inv of allInvoices) {
      try {
        const invoiceId = inv.id
        const status = mapStripeStatus(inv.status)
        const total = (inv.total || 0) / 100
        const subtotal = (inv.subtotal || 0) / 100
        const balanceDue = (inv.amount_remaining || 0) / 100
        const currency = (inv.currency || 'cad').toUpperCase()
        const date = inv.created ? new Date(inv.created * 1000).toISOString().slice(0, 10) : null
        const docNumber = inv.number || null

        // Resolve subscription
        let subscriptionId = null
        const stripeSub = typeof inv.subscription === 'string' ? inv.subscription : inv.subscription?.id
        if (stripeSub) {
          const subRow = db.prepare('SELECT id FROM subscriptions WHERE stripe_id=?').get(stripeSub)
          if (subRow) subscriptionId = subRow.id
        }

        // Resolve company
        const customerEmail = inv.customer_email || null
        const customerName = inv.customer_name || null
        let companyId = findCompanyByEmail(customerEmail) || findCompanyByName(customerName)

        // Check if facture exists
        const existing = db.prepare("SELECT id FROM factures WHERE invoice_id=?").get(invoiceId)

        if (existing) {
          updateStmt.run(
            status, total, subtotal, balanceDue, currency, date, docNumber,
            subscriptionId, companyId, invoiceId
          )
          batchProgress.updated++
        } else {
          insertStmt.run(
            randomUUID(), invoiceId, companyId, docNumber, date,
            status, currency, subtotal, total, balanceDue, subscriptionId
          )
          batchProgress.created++
        }
      } catch (e) {
        batchProgress.errors.push({ invoice: inv.id, error: e.message })
      }
      batchProgress.processed++
    }

    console.log(`✅ Batch Stripe terminé: ${batchProgress.updated} MAJ, ${batchProgress.created} créées, ${batchProgress.errors.length} erreurs`)
  } catch (e) {
    console.error('❌ Batch Stripe erreur:', e.message)
    batchProgress.errors.push({ invoice: 'global', error: e.message })
  } finally {
    batchProgress.running = false
    batchRunning = false
  }
})

export default router
