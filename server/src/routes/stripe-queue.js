import { Router } from 'express'
import { randomUUID } from 'crypto'
import Stripe from 'stripe'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { logSystemRun } from '../services/systemAutomations.js'
import { downloadStripeInvoicePdf } from '../services/stripeInvoicePdf.js'
import { upsertFromInvoiceLines } from '../services/stripeInvoiceItems.js'

function getStripeKey() {
  const row = db.prepare(
    "SELECT value FROM connector_config WHERE connector='stripe' AND key='secret_key'"
  ).get()
  return row?.value || null
}

function findCompanyByStripeCustomerId(stripeCustomerId) {
  if (!stripeCustomerId) return null
  const row = db.prepare(
    'SELECT id FROM companies WHERE stripe_customer_id=? LIMIT 1'
  ).get(stripeCustomerId)
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

  const started = Date.now()
  batchRunning = true
  batchProgress = { running: true, total: 0, processed: 0, updated: 0, created: 0, skipped: 0, pdfs: 0, pdf_errors: 0, errors: [] }

  // Respond immediately — processing happens in background
  res.json({ ok: true, message: 'Batch démarré' })

  const stripe = new Stripe(secretKey)

  try {
    // Paginate all invoices
    const allInvoices = []
    for await (const inv of stripe.invoices.list({ limit: 100, expand: ['data.charge', 'data.lines.data.price'] })) {
      allInvoices.push(inv)
    }
    batchProgress.total = allInvoices.length
    console.log(`📥 Batch Stripe: ${allInvoices.length} factures récupérées`)

    const updateStmt = db.prepare(`
      UPDATE factures SET
        status=?, total_amount=?, amount_before_tax_cad=?, balance_due=?,
        currency=?, document_date=?, document_number=COALESCE(document_number,?),
        subscription_id=COALESCE(subscription_id,?), company_id=COALESCE(company_id,?),
        montant_avant_taxes=?,
        sync_source='Factures Stripe', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE invoice_id=?
    `)

    const insertStmt = db.prepare(`
      INSERT INTO factures (id, invoice_id, company_id, document_number, document_date,
        status, currency, amount_before_tax_cad, total_amount, balance_due,
        subscription_id, sync_source, montant_avant_taxes, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'Factures Stripe',?,strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `)

    const samples = [] // { factureId, invoiceNumber, action }
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

        // Resolve company — strictement par stripe_customer_id
        const stripeCustomerId = typeof inv.customer === 'string'
          ? inv.customer
          : (inv.customer?.id || null)
        const companyId = findCompanyByStripeCustomerId(stripeCustomerId)

        // Check if facture exists
        const existing = db.prepare("SELECT id, airtable_pdf_path FROM factures WHERE invoice_id=?").get(invoiceId)

        let factureId
        let hasPdf
        if (existing) {
          updateStmt.run(
            status, total, subtotal, balanceDue, currency, date, docNumber,
            subscriptionId, companyId, String(subtotal), invoiceId
          )
          batchProgress.updated++
          factureId = existing.id
          hasPdf = !!existing.airtable_pdf_path
          if (samples.length < 10) samples.push({ factureId: existing.id, invoiceNumber: docNumber || invoiceId, action: 'maj' })
        } else {
          const newId = randomUUID()
          insertStmt.run(
            newId, invoiceId, companyId, docNumber, date,
            status, currency, subtotal, total, balanceDue, subscriptionId, String(subtotal)
          )
          batchProgress.created++
          factureId = newId
          hasPdf = false
          if (samples.length < 10) samples.push({ factureId: newId, invoiceNumber: docNumber || invoiceId, action: 'créée' })
        }

        if (!hasPdf && inv.invoice_pdf) {
          try {
            const relPath = await downloadStripeInvoicePdf(inv, factureId)
            if (relPath) {
              db.prepare('UPDATE factures SET airtable_pdf_path=? WHERE id=?').run(relPath, factureId)
              batchProgress.pdfs++
            }
          } catch (e) {
            batchProgress.pdf_errors++
            console.error(`❌ Stripe PDF dl ${factureId}:`, e.message)
          }
        }

        // Upsert des lignes — inv.lines.data inclus jusqu'à 10. Si has_more,
        // paginer via listLineItems pour récupérer le reste avec price expandé.
        try {
          let allLines = inv.lines?.data || []
          if (inv.lines?.has_more) {
            for await (const ln of stripe.invoices.listLineItems(invoiceId, { limit: 100, expand: ['data.price'] })) {
              if (!allLines.find(x => x.id === ln.id)) allLines.push(ln)
            }
          }
          if (allLines.length) upsertFromInvoiceLines(factureId, invoiceId, allLines)
        } catch (e) {
          console.error(`❌ Stripe lines upsert ${invoiceId}:`, e.message)
          batchProgress.errors.push({ invoice: invoiceId, error: `lines: ${e.message}` })
        }
      } catch (e) {
        batchProgress.errors.push({ invoice: inv.id, error: e.message })
      }
      batchProgress.processed++
    }

    console.log(`✅ Batch Stripe terminé: ${batchProgress.updated} MAJ, ${batchProgress.created} créées, ${batchProgress.errors.length} erreurs`)
    const appUrl = (process.env.APP_URL || 'https://customer.orisha.io').replace(/\/$/, '')
    const resultLines = [
      `${batchProgress.total} factures Stripe traitées`,
      `Mises à jour : ${batchProgress.updated}`,
      `Créées : ${batchProgress.created}`,
      `PDFs téléchargés : ${batchProgress.pdfs}${batchProgress.pdf_errors ? ` (${batchProgress.pdf_errors} erreur(s))` : ''}`,
      `Erreurs : ${batchProgress.errors.length}`,
    ]
    if (samples.length > 0) {
      resultLines.push('', `Exemples (${samples.length} sur ${batchProgress.updated + batchProgress.created}) :`)
      for (const s of samples) {
        resultLines.push(`  • ${s.invoiceNumber} (${s.action}) → ${appUrl}/erp/factures/${s.factureId}`)
      }
    }
    if (batchProgress.errors.length > 0) {
      resultLines.push('', 'Erreurs :')
      for (const e of batchProgress.errors.slice(0, 5)) {
        resultLines.push(`  • ${e.invoice} — ${e.error}`)
      }
    }
    logSystemRun('sys_stripe_batch_factures_sync', {
      status: batchProgress.errors.length > 0 ? 'error' : 'success',
      result: resultLines.join('\n'),
      error: batchProgress.errors.length > 0 ? `${batchProgress.errors.length} erreur(s)` : null,
      duration_ms: Date.now() - started,
    })
  } catch (e) {
    console.error('❌ Batch Stripe erreur:', e.message)
    batchProgress.errors.push({ invoice: 'global', error: e.message })
    logSystemRun('sys_stripe_batch_factures_sync', {
      status: 'error',
      error: e.message,
      duration_ms: Date.now() - started,
    })
  } finally {
    batchProgress.running = false
    batchRunning = false
  }
})

export default router
