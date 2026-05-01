import { Router } from 'express'
import { randomUUID } from 'crypto'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { postInvoicePaidJE, processRefund } from '../services/quickbooks.js'
import { qbEntityUrl } from '../connectors/quickbooks.js'

const router = Router()
router.use(requireAuth)

const VALID_METHODS = new Set(['cheque', 'virement_bancaire', 'interac', 'comptant', 'autre'])
const VALID_CURRENCIES = new Set(['CAD', 'USD'])

// GET /api/payments/facture/:factureId — liste les paiements/refunds d'une facture
router.get('/facture/:factureId', (req, res) => {
  const rows = db.prepare(`
    SELECT id, facture_id, direction, method, received_at, amount, currency,
           amount_cad, exchange_rate, stripe_balance_tx_id, stripe_charge_id,
           stripe_refund_id, qb_payment_id, qb_journal_entry_id, notes,
           created_by, created_at, updated_at
    FROM payments
    WHERE facture_id = ?
    ORDER BY received_at, created_at
  `).all(req.params.factureId)
  // Pré-chargé pour les fallbacks de lookup payout (invoice_id + payment_intent).
  const factureRow = db.prepare(
    'SELECT invoice_id, paid_payment_intent FROM factures WHERE id=?'
  ).get(req.params.factureId) || {}
  const factureInvoiceId = factureRow.invoice_id || null
  const facturePaymentIntent = factureRow.paid_payment_intent || null

  // Ajoute les URLs profondes QB + le payout pour chaque ligne. Stratégies de
  // matching balance_transaction (du plus précis au plus large) :
  //   1. stripe_balance_tx_id (lien direct sur la ligne payments réelle)
  //   2. stripe_charge_id     → bt.source_id
  //   3. stripe_invoice_id    → bt.stripe_invoice_id (sparse mais exact)
  //   4. payment_intent       → LIKE sur bt.raw (match les charges abonnement
  //      où invoice n'est pas linké directement mais où le PI est dans le raw)
  for (const r of rows) {
    r.qb_payment_url = r.qb_payment_id ? qbEntityUrl('salesreceipt', r.qb_payment_id) : null
    r.qb_journal_entry_url = r.qb_journal_entry_id ? qbEntityUrl('journal', r.qb_journal_entry_id) : null
    if (r.method === 'stripe') {
      let bt = null
      if (r.stripe_balance_tx_id) {
        bt = db.prepare('SELECT payout_stripe_id FROM stripe_balance_transactions WHERE stripe_id=?').get(r.stripe_balance_tx_id)
      }
      if (!bt && r.stripe_charge_id) {
        bt = db.prepare('SELECT payout_stripe_id FROM stripe_balance_transactions WHERE source_id=?').get(r.stripe_charge_id)
      }
      if (!bt && factureInvoiceId) {
        bt = db.prepare("SELECT payout_stripe_id FROM stripe_balance_transactions WHERE stripe_invoice_id=? AND type='charge' ORDER BY created_date DESC LIMIT 1").get(factureInvoiceId)
      }
      if (!bt && facturePaymentIntent) {
        bt = db.prepare("SELECT payout_stripe_id FROM stripe_balance_transactions WHERE type='charge' AND raw LIKE ? ORDER BY created_date DESC LIMIT 1").get('%' + facturePaymentIntent + '%')
      }
      r.payout_stripe_id = bt?.payout_stripe_id || null
    }
  }

  // Stripe : pas de ligne `payments` créée à invoice.paid (le push QB se fait
  // au payout). Mais l'utilisateur veut voir le paiement dès maintenant. On
  // synthétise une ligne virtuelle depuis factures.paid_at — flagée pour que
  // le client la rende en lecture seule.
  const hasStripeRow = rows.some(r => r.method === 'stripe' && r.direction === 'in')
  if (!hasStripeRow) {
    const f = db.prepare(`
      SELECT id, paid_at, paid_amount, paid_charge_id, paid_payment_intent,
             currency, total_amount,
             status, balance_due, deferred_revenue_qb_ref, revenue_recognized_je_id
      FROM factures WHERE id=?
    `).get(req.params.factureId)
    if (f && f.paid_at) {
      // URL QB : prefer la JE de constat, sinon la transaction de revenu reçu d'avance.
      let qbUrl = null
      if (f.revenue_recognized_je_id) qbUrl = qbEntityUrl('journal', f.revenue_recognized_je_id)
      else if (f.deferred_revenue_qb_ref) {
        const idx = f.deferred_revenue_qb_ref.indexOf(':')
        if (idx > 0) qbUrl = qbEntityUrl(f.deferred_revenue_qb_ref.slice(0, idx), f.deferred_revenue_qb_ref.slice(idx + 1))
      }
      // Lookup payout : charge_id → invoice_id → payment_intent (raw LIKE).
      let payoutId = null
      if (f.paid_charge_id) {
        payoutId = db.prepare('SELECT payout_stripe_id FROM stripe_balance_transactions WHERE source_id=?').get(f.paid_charge_id)?.payout_stripe_id || null
      }
      if (!payoutId && factureInvoiceId) {
        payoutId = db.prepare("SELECT payout_stripe_id FROM stripe_balance_transactions WHERE stripe_invoice_id=? AND type='charge' ORDER BY created_date DESC LIMIT 1").get(factureInvoiceId)?.payout_stripe_id || null
      }
      if (!payoutId && f.paid_payment_intent) {
        payoutId = db.prepare("SELECT payout_stripe_id FROM stripe_balance_transactions WHERE type='charge' AND raw LIKE ? ORDER BY created_date DESC LIMIT 1").get('%' + f.paid_payment_intent + '%')?.payout_stripe_id || null
      }
      rows.push({
        id: `synthetic:stripe:${f.id}`,
        facture_id: f.id,
        direction: 'in',
        method: 'stripe',
        received_at: f.paid_at,
        amount: f.paid_amount != null ? f.paid_amount : Number(f.total_amount) || 0,
        currency: (f.currency || 'CAD').toUpperCase(),
        amount_cad: null,
        exchange_rate: null,
        stripe_balance_tx_id: null,
        stripe_charge_id: f.paid_charge_id,
        stripe_refund_id: null,
        qb_payment_id: null,
        qb_journal_entry_id: null,
        qb_payment_url: qbUrl,
        qb_journal_entry_url: null,
        payout_stripe_id: payoutId,
        notes: 'Paiement Stripe — JE en QB posée au payout',
        synthetic: true,
        created_by: null,
        created_at: f.paid_at,
        updated_at: f.paid_at,
      })
      // Tri par date après ajout du synthetic
      rows.sort((a, b) => String(a.received_at).localeCompare(String(b.received_at)))
    }
  }

  res.json(rows)
})

// POST /api/payments — saisie manuelle d'un paiement (in) ou remboursement (out) hors-Stripe
// Les paiements Stripe sont créés automatiquement par le webhook invoice.paid (method='stripe').
router.post('/', async (req, res) => {
  const { facture_id, direction, method, received_at, amount, currency, notes } = req.body || {}

  if (!facture_id) return res.status(400).json({ error: 'facture_id requis' })
  if (direction !== 'in' && direction !== 'out') return res.status(400).json({ error: 'direction doit être "in" ou "out"' })
  if (!VALID_METHODS.has(method)) return res.status(400).json({ error: `method invalide (attendu: ${[...VALID_METHODS].join(', ')})` })
  const amt = Number(amount)
  if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'amount doit être un nombre > 0' })
  const cur = String(currency || 'CAD').toUpperCase()
  if (!VALID_CURRENCIES.has(cur)) return res.status(400).json({ error: 'currency doit être CAD ou USD' })
  const receivedIso = received_at ? new Date(received_at).toISOString() : new Date().toISOString()
  if (Number.isNaN(Date.parse(receivedIso))) return res.status(400).json({ error: 'received_at invalide' })

  const facture = db.prepare('SELECT id FROM factures WHERE id = ?').get(facture_id)
  if (!facture) return res.status(404).json({ error: 'Facture introuvable' })

  const id = randomUUID()
  db.prepare(`
    INSERT INTO payments (
      id, facture_id, direction, method, received_at, amount, currency,
      notes, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, facture_id, direction, method, receivedIso, amt, cur, notes || null, req.user?.id || null)

  // Pose la JE QB. Si échec, on retourne quand même 201 + le payload, avec un warning.
  // La ligne payments reste en DB sans qb_journal_entry_id pour retry manuel.
  let qbResult = null
  let qbError = null
  try {
    qbResult = direction === 'in'
      ? await postInvoicePaidJE(id)
      : await processRefund(id)
  } catch (err) {
    console.error(`payment JE ${direction} échouée pour ${id}:`, err.message)
    qbError = err.message
  }

  const created = db.prepare('SELECT * FROM payments WHERE id = ?').get(id)
  res.status(201).json({ payment: created, qb: qbResult, qb_error: qbError })
})

// POST /api/payments/:id/retry-qb — re-tente la JE QB pour un payment qui n'en a pas
router.post('/:id/retry-qb', async (req, res) => {
  const p = db.prepare('SELECT id, direction, qb_journal_entry_id FROM payments WHERE id = ?').get(req.params.id)
  if (!p) return res.status(404).json({ error: 'Paiement introuvable' })
  if (p.qb_journal_entry_id) return res.status(409).json({ error: 'JE déjà posée', qb_journal_entry_id: p.qb_journal_entry_id })
  try {
    const r = p.direction === 'in' ? await postInvoicePaidJE(p.id) : await processRefund(p.id)
    res.json(r)
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

// DELETE /api/payments/:id — supprime une ligne payments (admin only, à utiliser
// avec prudence : ne supprime PAS la JE QB associée, qui doit être annulée manuellement).
router.delete('/:id', (req, res) => {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin requis' })
  const p = db.prepare('SELECT id, qb_journal_entry_id FROM payments WHERE id = ?').get(req.params.id)
  if (!p) return res.status(404).json({ error: 'Paiement introuvable' })
  db.prepare('DELETE FROM payments WHERE id = ?').run(req.params.id)
  res.json({ ok: true, qb_journal_entry_id: p.qb_journal_entry_id, warning: p.qb_journal_entry_id ? 'JE QB associée non supprimée — annuler manuellement dans QB' : null })
})

export default router
