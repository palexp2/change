import { Router } from 'express'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { syncStripePayouts, syncStripeBalanceTransactions, syncAllPayoutsBalanceTransactions, backfillRefundsToFactures, fixRefundDocumentNumbers } from '../services/stripe.js'
import { logSystemRun } from '../services/systemAutomations.js'
import { buildDepositFromPayout, pushDepositFromPayout } from '../services/quickbooks.js'
import { qbEntityUrl, qbGet } from '../connectors/quickbooks.js'

const router = Router()
router.use(requireAuth)

router.get('/', (req, res) => {
  const { limit = 100, page = 1, status } = req.query
  const limitAll = limit === 'all'
  const limitVal = limitAll ? -1 : parseInt(limit)
  const offset = limitAll ? 0 : (parseInt(page) - 1) * parseInt(limit)
  let where = ''
  const params = []
  if (status) { where = 'WHERE status = ?'; params.push(status) }
  const total = db.prepare(`SELECT COUNT(*) as c FROM stripe_payouts ${where}`).get(...params).c
  const data = db.prepare(
    `SELECT id, stripe_id, amount, currency, status, arrival_date, created_date,
            method, type, description, bank_name, bank_last4,
            failure_code, failure_message, automatic, stripe_url,
            qb_deposit_id, qb_pushed_at
     FROM stripe_payouts ${where}
     ORDER BY arrival_date DESC, created_date DESC
     LIMIT ? OFFSET ?`
  ).all(...params, limitVal, offset)
  res.json({ data, total, page: parseInt(page), limit: parseInt(limit) })
})

router.get('/:stripeId', (req, res) => {
  const payout = db.prepare(
    `SELECT id, stripe_id, amount, currency, status, arrival_date, created_date,
            method, type, description, bank_name, bank_last4,
            failure_code, failure_message, automatic, stripe_url,
            qb_deposit_id, qb_pushed_at, synced_at
     FROM stripe_payouts WHERE stripe_id = ?`
  ).get(req.params.stripeId)
  if (!payout) return res.status(404).json({ error: 'Payout introuvable' })
  payout.qb_deposit_url = payout.qb_deposit_id ? qbEntityUrl('deposit', payout.qb_deposit_id) : null
  const transactions = db.prepare(
    `SELECT stripe_id, type, reporting_category, amount, fee, net, currency,
            description, source_id, source_type, stripe_invoice_id, invoice_number,
            stripe_customer_id, customer_name, is_subscription, qb_customer_id,
            qb_tax_code, tax_details, invoice_tax_gst, invoice_tax_qst,
            fee_tax_gst, fee_tax_qst, created_date
     FROM stripe_balance_transactions
     WHERE payout_stripe_id = ? ORDER BY created_date`
  ).all(req.params.stripeId)
  res.json({ payout, transactions })
})

router.post('/sync', async (req, res) => {
  try {
    const fullHistory = req.body?.fullHistory !== false
    const result = await syncStripePayouts({ fullHistory })
    res.json(result)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Sync balance_transactions for a specific payout
router.post('/:stripeId/sync-transactions', async (req, res) => {
  try {
    const result = await syncStripeBalanceTransactions(req.params.stripeId)
    const bts = db.prepare(
      'SELECT stripe_id, type, amount, fee, net, currency, invoice_number, customer_name, is_subscription FROM stripe_balance_transactions WHERE payout_stripe_id=? ORDER BY created_date'
    ).all(req.params.stripeId)
    res.json({ ...result, transactions: bts })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Preview the QB Deposit payload without sending
router.get('/:stripeId/preview-deposit', async (req, res) => {
  try {
    const { deposit, summary, warnings } = await buildDepositFromPayout(req.params.stripeId)
    res.json({ deposit, summary, warnings })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// Sync balance_transactions for every payout that has none yet (or all, with onlyMissing=false).
router.post('/sync-all-transactions', async (req, res) => {
  const started = Date.now()
  try {
    const onlyMissing = req.body?.onlyMissing !== false
    const limit = req.body?.limit ? parseInt(req.body.limit, 10) : null
    const result = await syncAllPayoutsBalanceTransactions({ onlyMissing, limit })
    logSystemRun('sys_stripe_bulk_bt_sync', {
      status: 'success',
      result: `${result.payoutsProcessed} payouts traités · ${result.created} BT créés · ${result.updated} MAJ · ${result.errors.length} erreur(s)`,
      duration_ms: Date.now() - started,
      triggerData: { onlyMissing, limit },
    })
    res.json(result)
  } catch (e) {
    logSystemRun('sys_stripe_bulk_bt_sync', { status: 'error', error: e.message, duration_ms: Date.now() - started })
    res.status(500).json({ error: e.message })
  }
})

// Backfill the factures table from refund balance_transactions already synced.
router.post('/backfill-refunds', (req, res) => {
  const started = Date.now()
  try {
    const dryRun = req.body?.dryRun === true
    const result = backfillRefundsToFactures({ dryRun })
    logSystemRun('sys_stripe_refunds_backfill', {
      status: 'success',
      result: `${result.created} créé(s) · ${result.skipped} skip · ${result.unmatched} sans company sur ${result.total}${dryRun ? ' (dry-run)' : ''}`,
      duration_ms: Date.now() - started,
      triggerData: { dryRun },
    })
    res.json(result)
  } catch (e) {
    logSystemRun('sys_stripe_refunds_backfill', { status: 'error', error: e.message, duration_ms: Date.now() - started })
    res.status(500).json({ error: e.message })
  }
})

// Backfill document_number sur les factures de type Remboursement qui n'en ont pas.
// Résout via l'API Stripe : refund → charge → invoice → document_number + "-R".
router.post('/fix-refund-doc-numbers', async (req, res) => {
  const started = Date.now()
  try {
    const dryRun = req.body?.dryRun === true
    const result = await fixRefundDocumentNumbers({ dryRun })
    logSystemRun('sys_stripe_refund_doc_numbers_fix', {
      status: 'success',
      result: `${result.patched} patchés · ${result.unmatched} sans facture d'origine · ${result.errors} erreurs sur ${result.total}${dryRun ? ' (dry-run)' : ''}`,
      duration_ms: Date.now() - started,
      triggerData: { dryRun },
    })
    res.json(result)
  } catch (e) {
    logSystemRun('sys_stripe_refund_doc_numbers_fix', { status: 'error', error: e.message, duration_ms: Date.now() - started })
    res.status(500).json({ error: e.message })
  }
})

// Unlink the QB Deposit from this payout (when it has been deleted/voided in QB).
// Vérifie d'abord auprès de QB que le Deposit n'existe plus — accepte { force: true }
// pour forcer quand la vérification ne peut pas être faite.
router.post('/:stripeId/unlink-deposit', async (req, res) => {
  const payout = db.prepare('SELECT qb_deposit_id FROM stripe_payouts WHERE stripe_id=?').get(req.params.stripeId)
  if (!payout) return res.status(404).json({ error: 'Payout introuvable' })
  if (!payout.qb_deposit_id) return res.status(400).json({ error: 'Aucun Deposit QB lié à ce payout' })

  const force = req.body?.force === true
  if (!force) {
    try {
      const r = await qbGet(`/deposit/${payout.qb_deposit_id}`)
      if (r?.Deposit) {
        return res.status(409).json({
          error: `Deposit QB #${payout.qb_deposit_id} existe encore dans QuickBooks. Supprime-le d'abord ou renvoie { force: true } pour délier quand même.`,
        })
      }
    } catch (e) {
      // Code 610 "Objet introuvable" / 400 not-found → confirme que le deposit n'existe plus
      if (!/610|introuvable|not found/i.test(e.message)) {
        return res.status(502).json({ error: `Vérification QB échouée: ${e.message}` })
      }
    }
  }

  db.prepare(`UPDATE stripe_payouts SET qb_deposit_id=NULL, qb_pushed_at=NULL WHERE stripe_id=?`)
    .run(req.params.stripeId)
  res.json({ ok: true, previous_qb_deposit_id: payout.qb_deposit_id })
})

// Push deposit to QB. Requires confirm=true in body for safety.
router.post('/:stripeId/push-deposit', async (req, res) => {
  try {
    if (req.body?.confirm !== true) {
      return res.status(400).json({ error: 'Confirmation requise: envoyer { confirm: true }' })
    }
    const result = await pushDepositFromPayout(req.params.stripeId)
    result.qb_deposit_url = qbEntityUrl('deposit', result.qb_deposit_id)
    res.json(result)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router
