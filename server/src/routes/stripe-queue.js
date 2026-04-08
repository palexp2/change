import { Router } from 'express'
import { randomUUID } from 'crypto'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { pushStripeInvoiceToQB } from '../services/quickbooks.js'

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

// GET /api/stripe-queue/tax-mappings — list tax mappings
router.get('/tax-mappings/list', (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM stripe_qb_tax_mapping ORDER BY created_at'
  ).all()
  res.json(rows)
})

// POST /api/stripe-queue/tax-mappings — create/update tax mapping
router.post('/tax-mappings', (req, res) => {
  const { stripe_tax_id, stripe_tax_description, stripe_tax_percentage, qb_tax_code } = req.body
  if (!stripe_tax_id || !qb_tax_code) {
    return res.status(400).json({ error: 'stripe_tax_id et qb_tax_code requis' })
  }

  const existing = db.prepare(
    'SELECT id FROM stripe_qb_tax_mapping WHERE stripe_tax_id=?'
  ).get(stripe_tax_id)

  if (existing) {
    db.prepare(
      'UPDATE stripe_qb_tax_mapping SET qb_tax_code=?, stripe_tax_description=?, stripe_tax_percentage=? WHERE id=?'
    ).run(qb_tax_code, stripe_tax_description || null, stripe_tax_percentage || null, existing.id)
    res.json({ ok: true, id: existing.id })
  } else {
    const id = randomUUID()
    db.prepare(`
      INSERT INTO stripe_qb_tax_mapping (id, stripe_tax_id, stripe_tax_description, stripe_tax_percentage, qb_tax_code)
      VALUES (?,?,?,?,?)
    `).run(id, stripe_tax_id, stripe_tax_description || null, stripe_tax_percentage || null, qb_tax_code)
    res.json({ ok: true, id })
  }
})

// DELETE /api/stripe-queue/tax-mappings/:id
router.delete('/tax-mappings/:id', (req, res) => {
  db.prepare('DELETE FROM stripe_qb_tax_mapping WHERE id=?')
    .run(req.params.id)
  res.json({ ok: true })
})

export default router
