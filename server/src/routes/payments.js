import { Router } from 'express'
import { randomUUID } from 'crypto'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { postPaymentDeposit, processRefund } from '../services/quickbooks.js'
import { qbEntityUrl, qbGet } from '../connectors/quickbooks.js'
import { recomputeFactureBalance } from '../services/factureBalance.js'

const router = Router()
router.use(requireAuth)

const VALID_METHODS = new Set(['cheque', 'virement_bancaire', 'interac', 'comptant', 'autre'])
const VALID_CURRENCIES = new Set(['CAD', 'USD'])

// GET /api/payments/facture/:factureId — liste les paiements/refunds d'une facture
router.get('/facture/:factureId', (req, res) => {
  const rows = db.prepare(`
    SELECT id, facture_id, direction, method, received_at, amount, currency,
           amount_cad, exchange_rate, stripe_balance_tx_id, stripe_charge_id,
           stripe_refund_id, qb_payment_id, qb_journal_entry_id, qb_deposit_id,
           qb_skipped, qb_credit_account_id, qb_credit_account_name, notes,
           created_by, created_at, updated_at
    FROM payments
    WHERE facture_id = ?
    ORDER BY received_at, created_at
  `).all(req.params.factureId)
  for (const r of rows) r.qb_skipped = !!r.qb_skipped
  // Pré-chargé pour les fallbacks de lookup payout (invoice_id + payment_intent).
  const factureRow = db.prepare(
    'SELECT invoice_id, paid_payment_intent FROM factures WHERE id=?'
  ).get(req.params.factureId) || {}
  const factureInvoiceId = factureRow.invoice_id || null
  const facturePaymentIntent = factureRow.paid_payment_intent || null

  // Ajoute les URLs profondes QB + le payout pour chaque ligne. Stratégies de
  // matching balance_transaction (du plus précis au plus large) :
  //   1. stripe_balance_tx_id (lien direct sur la ligne payments réelle)
  //   2. Pour direction='out' (refund) : source_id = stripe_refund_id, type IN
  //      ('refund','payment_refund'). Pas de fallback sur stripe_charge_id —
  //      sinon on tombe sur la BT du paiement initial, dans un payout antérieur.
  //   3. Pour direction='in'  : source_id = stripe_charge_id, puis fallbacks
  //      par invoice_id / payment_intent (raw LIKE).
  // Une fois le payout identifié, on attache aussi son qb_deposit_id : la JE QB
  // d'un paiement/refund Stripe est posée au push du payout (pas par ligne).
  const payoutQbCache = new Map()
  function getPayoutQb(payoutStripeId) {
    if (!payoutStripeId) return null
    if (payoutQbCache.has(payoutStripeId)) return payoutQbCache.get(payoutStripeId)
    const row = db.prepare('SELECT qb_deposit_id FROM stripe_payouts WHERE stripe_id=?').get(payoutStripeId)
    const qbId = row?.qb_deposit_id || null
    payoutQbCache.set(payoutStripeId, qbId)
    return qbId
  }
  for (const r of rows) {
    r.qb_payment_url = r.qb_payment_id ? qbEntityUrl('salesreceipt', r.qb_payment_id) : null
    r.qb_journal_entry_url = r.qb_journal_entry_id ? qbEntityUrl('journal', r.qb_journal_entry_id) : null
    r.qb_deposit_url = r.qb_deposit_id ? qbEntityUrl('deposit', r.qb_deposit_id) : null
    if (r.method === 'stripe') {
      let bt = null
      if (r.stripe_balance_tx_id) {
        bt = db.prepare('SELECT payout_stripe_id FROM stripe_balance_transactions WHERE stripe_id=?').get(r.stripe_balance_tx_id)
      }
      if (r.direction === 'out') {
        if (!bt && r.stripe_refund_id) {
          bt = db.prepare(
            "SELECT payout_stripe_id FROM stripe_balance_transactions WHERE source_id=? AND type IN ('refund','payment_refund')"
          ).get(r.stripe_refund_id)
        }
      } else {
        if (!bt && r.stripe_charge_id) {
          bt = db.prepare(
            "SELECT payout_stripe_id FROM stripe_balance_transactions WHERE source_id=? AND type IN ('charge','payment')"
          ).get(r.stripe_charge_id)
        }
        if (!bt && factureInvoiceId) {
          bt = db.prepare("SELECT payout_stripe_id FROM stripe_balance_transactions WHERE stripe_invoice_id=? AND type IN ('charge','payment') ORDER BY created_date DESC LIMIT 1").get(factureInvoiceId)
        }
        if (!bt && facturePaymentIntent) {
          bt = db.prepare("SELECT payout_stripe_id FROM stripe_balance_transactions WHERE type IN ('charge','payment') AND raw LIKE ? ORDER BY created_date DESC LIMIT 1").get('%' + facturePaymentIntent + '%')
        }
      }
      r.payout_stripe_id = bt?.payout_stripe_id || null
      r.payout_qb_deposit_id = getPayoutQb(r.payout_stripe_id)
      r.payout_qb_deposit_url = r.payout_qb_deposit_id ? qbEntityUrl('deposit', r.payout_qb_deposit_id) : null
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
        payoutId = db.prepare("SELECT payout_stripe_id FROM stripe_balance_transactions WHERE stripe_invoice_id=? AND type IN ('charge','payment') ORDER BY created_date DESC LIMIT 1").get(factureInvoiceId)?.payout_stripe_id || null
      }
      if (!payoutId && f.paid_payment_intent) {
        payoutId = db.prepare("SELECT payout_stripe_id FROM stripe_balance_transactions WHERE type IN ('charge','payment') AND raw LIKE ? ORDER BY created_date DESC LIMIT 1").get('%' + f.paid_payment_intent + '%')?.payout_stripe_id || null
      }
      const payoutQbDepositId = getPayoutQb(payoutId)
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
        qb_deposit_id: null,
        qb_payment_url: qbUrl,
        qb_journal_entry_url: null,
        qb_deposit_url: null,
        payout_stripe_id: payoutId,
        payout_qb_deposit_id: payoutQbDepositId,
        payout_qb_deposit_url: payoutQbDepositId ? qbEntityUrl('deposit', payoutQbDepositId) : null,
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
  const { facture_id, direction, method, received_at, amount, currency, notes, skip_qb } = req.body || {}

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
      notes, created_by, qb_skipped
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, facture_id, direction, method, receivedIso, amt, cur, notes || null, req.user?.id || null, skip_qb ? 1 : 0)

  // Synchronise factures.balance_due / status avec les paiements locaux. Sans
  // ça, une facture Stripe payée hors Stripe (Interac, virement…) garderait le
  // solde renvoyé par Stripe (qui ne sait rien du paiement local).
  recomputeFactureBalance(facture_id)

  // Pose l'écriture comptable QB (Deposit pour 'in', JE/RR pour 'out'). Si échec,
  // on retourne quand même 201 + le payload, avec un warning. La ligne payments
  // reste en DB sans qb_deposit_id (ou qb_payment_id pour les refunds) pour retry manuel.
  // skip_qb=true : l'écriture QB a déjà été postée manuellement (ex. facture Stripe
  // paid-out-of-band dont l'encaissement Interac a été saisi à la main dans QB).
  // La row payments existe pour la traçabilité ERP, mais on n'appelle pas QB.
  let qbResult = null
  let qbError = null
  if (!skip_qb) {
    try {
      qbResult = direction === 'in'
        ? await postPaymentDeposit(id)
        : await processRefund(id)
    } catch (err) {
      console.error(`payment QB ${direction} échouée pour ${id}:`, err.message)
      qbError = err.message
    }
  }

  const created = db.prepare('SELECT * FROM payments WHERE id = ?').get(id)
  res.status(201).json({ payment: created, qb: qbResult, qb_error: qbError, qb_skipped: !!skip_qb })
})

// POST /api/payments/:id/retry-qb — re-tente la pose comptable QB pour un payment
// qui n'a ni Deposit, ni JE, ni SalesReceipt (échec précédent).
router.post('/:id/retry-qb', async (req, res) => {
  const p = db.prepare(
    'SELECT id, direction, qb_deposit_id, qb_journal_entry_id, qb_payment_id, qb_skipped FROM payments WHERE id = ?'
  ).get(req.params.id)
  if (!p) return res.status(404).json({ error: 'Paiement introuvable' })
  if (p.qb_skipped) {
    return res.status(409).json({
      error: 'Écriture QB volontairement skipée à la création — re-poster causerait un doublon. Utilise l\'édition raw (admin) pour ré-activer si besoin.',
      qb_skipped: true,
    })
  }
  if (p.qb_deposit_id || p.qb_journal_entry_id || p.qb_payment_id) {
    return res.status(409).json({
      error: 'Écriture QB déjà posée',
      qb_deposit_id: p.qb_deposit_id,
      qb_journal_entry_id: p.qb_journal_entry_id,
      qb_payment_id: p.qb_payment_id,
    })
  }
  try {
    const r = p.direction === 'in' ? await postPaymentDeposit(p.id) : await processRefund(p.id)
    res.json(r)
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

// GET /api/payments/:id/qb-link-suggestions — propose les opérations QB
// candidates pour rattacher manuellement un payment qb_skipped. Cherche dans
// une fenêtre de ±90 jours autour de payments.received_at les Deposits,
// JournalEntries et SalesReceipts qui référencent le QB customer de la
// company de la facture. Aucun filtre sur le montant (l'encaissement réel a
// pu être groupé avec d'autres factures dans QB).
router.get('/:id/qb-link-suggestions', async (req, res) => {
  const p = db.prepare(`
    SELECT p.id, p.received_at, p.amount, p.currency, p.facture_id,
           c.quickbooks_customer_id, c.quickbooks_customer_id_usd, c.name AS company_name
    FROM payments p
    JOIN factures f ON f.id = p.facture_id
    JOIN companies c ON c.id = f.company_id
    WHERE p.id = ?
  `).get(req.params.id)
  if (!p) return res.status(404).json({ error: 'Paiement ou company introuvable' })

  const customerIds = [p.quickbooks_customer_id, p.quickbooks_customer_id_usd].filter(Boolean)
  if (customerIds.length === 0) {
    return res.json({ suggestions: [], reason: 'Aucun QB customer id rattaché à la company' })
  }

  const refDate = (p.received_at || new Date().toISOString()).slice(0, 10)
  const refMs = Date.parse(refDate)
  const dayMs = 86400000
  const startDate = new Date(refMs - 90 * dayMs).toISOString().slice(0, 10)
  const endDate = new Date(refMs + 90 * dayMs).toISOString().slice(0, 10)
  const customerIn = customerIds.map(id => `'${String(id).replace(/'/g, "''")}'`).join(',')
  const dateClause = `TxnDate >= '${startDate}' AND TxnDate <= '${endDate}'`

  // QB query API : filtre sur LineDetail.Entity n'est pas supporté pour
  // Deposit/JE — on récupère par date, puis filtre côté serveur par lookup
  // d'entité. SalesReceipt : CustomerRef est top-level → filtre direct.
  const queries = {
    deposit: `SELECT * FROM Deposit WHERE ${dateClause} MAXRESULTS 200`,
    journal: `SELECT * FROM JournalEntry WHERE ${dateClause} MAXRESULTS 200`,
    salesreceipt: `SELECT * FROM SalesReceipt WHERE CustomerRef IN (${customerIn}) AND ${dateClause} MAXRESULTS 200`,
  }

  const suggestions = []
  const errors = {}
  await Promise.all(Object.entries(queries).map(async ([key, q]) => {
    try {
      const data = await qbGet(`/query?query=${encodeURIComponent(q)}`)
      const root = data.QueryResponse || {}
      if (key === 'deposit') {
        for (const d of (root.Deposit || [])) {
          // Trouve la ligne qui référence le client : c'est elle qui porte
          // l'AccountRef du compte crédité (typiquement 23900 deferred,
          // 40000 ventes ou 12000 AR selon le scénario comptable).
          const matchedLine = (d.Line || []).find(l =>
            l.DepositLineDetail?.Entity?.value && customerIds.includes(String(l.DepositLineDetail.Entity.value))
          )
          if (matchedLine) {
            const acct = matchedLine.DepositLineDetail?.AccountRef
            suggestions.push({
              type: 'deposit',
              column: 'qb_deposit_id',
              prefix: 'DEP',
              qb_id: String(d.Id),
              txn_date: d.TxnDate,
              amount: Number(d.TotalAmt || 0),
              line_amount: Number(matchedLine.Amount || 0),
              description: d.PrivateNote || d.DocNumber || `Deposit ${d.Id}`,
              credit_account_id: acct?.value ? String(acct.value) : null,
              credit_account_name: acct?.name || null,
            })
          }
        }
      } else if (key === 'journal') {
        for (const j of (root.JournalEntry || [])) {
          // Pour une JE, prends la première ligne Credit qui touche le client
          // comme représentative du compte crédité côté revenu.
          const matchedLine = (j.Line || []).find(l =>
            l.JournalEntryLineDetail?.PostingType === 'Credit'
            && l.JournalEntryLineDetail?.Entity?.EntityRef?.value
            && customerIds.includes(String(l.JournalEntryLineDetail.Entity.EntityRef.value))
          ) || (j.Line || []).find(l =>
            l.JournalEntryLineDetail?.Entity?.EntityRef?.value
            && customerIds.includes(String(l.JournalEntryLineDetail.Entity.EntityRef.value))
          )
          if (matchedLine) {
            const acct = matchedLine.JournalEntryLineDetail?.AccountRef
            const totalDebit = (j.Line || [])
              .filter(l => l.JournalEntryLineDetail?.PostingType === 'Debit')
              .reduce((s, l) => s + Number(l.Amount || 0), 0)
            suggestions.push({
              type: 'journal',
              column: 'qb_journal_entry_id',
              prefix: 'JE',
              qb_id: String(j.Id),
              txn_date: j.TxnDate,
              amount: totalDebit || Number(matchedLine.Amount || 0),
              line_amount: Number(matchedLine.Amount || 0),
              description: j.PrivateNote || `JE ${j.Id}`,
              credit_account_id: acct?.value ? String(acct.value) : null,
              credit_account_name: acct?.name || null,
            })
          }
        }
      } else if (key === 'salesreceipt') {
        for (const s of (root.SalesReceipt || [])) {
          // Pour un SR, les revenus passent via les Items.IncomeAccountRef.
          // On affiche le 1er ItemRef à titre informatif (l'API SR ne renvoie
          // pas directement le compte d'income).
          const firstItem = (s.Line || []).find(l => l.SalesItemLineDetail?.ItemRef?.name)?.SalesItemLineDetail?.ItemRef
          suggestions.push({
            type: 'salesreceipt',
            column: 'qb_payment_id',
            prefix: 'SR',
            qb_id: String(s.Id),
            txn_date: s.TxnDate,
            amount: Number(s.TotalAmt || 0),
            description: s.PrivateNote || s.DocNumber || `SR ${s.Id}`,
            credit_account_id: null,
            credit_account_name: firstItem?.name ? `Item: ${firstItem.name}` : null,
          })
        }
      }
    } catch (err) {
      errors[key] = err.message
    }
  }))

  // Tri par proximité avec la date du paiement.
  suggestions.sort((a, b) => Math.abs(Date.parse(a.txn_date) - refMs) - Math.abs(Date.parse(b.txn_date) - refMs))

  res.json({
    suggestions,
    payment_amount: Number(p.amount),
    payment_currency: p.currency,
    payment_received_at: refDate,
    company_name: p.company_name,
    errors: Object.keys(errors).length ? errors : undefined,
  })
})

// GET /api/payments/:id/qb-credit-account — fetch QB par l'id déjà rattaché
// au payment (qb_deposit_id / qb_journal_entry_id / qb_payment_id) et extrait
// le compte crédité depuis la ligne qui référence le client. Utile quand on
// veut compléter le qb_credit_account_name sur une row déjà liée (avant le
// fix, le compte n'était pas capturé). Retourne 404 si aucun id QB lié.
router.get('/:id/qb-credit-account', async (req, res) => {
  const p = db.prepare(`
    SELECT p.id, p.qb_deposit_id, p.qb_journal_entry_id, p.qb_payment_id,
           c.quickbooks_customer_id, c.quickbooks_customer_id_usd
    FROM payments p
    JOIN factures f ON f.id = p.facture_id
    JOIN companies c ON c.id = f.company_id
    WHERE p.id = ?
  `).get(req.params.id)
  if (!p) return res.status(404).json({ error: 'Paiement ou company introuvable' })

  let entityType, qbId
  if (p.qb_deposit_id) { entityType = 'Deposit'; qbId = p.qb_deposit_id }
  else if (p.qb_journal_entry_id) { entityType = 'JournalEntry'; qbId = p.qb_journal_entry_id }
  else if (p.qb_payment_id) { entityType = 'SalesReceipt'; qbId = p.qb_payment_id }
  else return res.status(404).json({ error: 'Aucun id QB rattaché à ce paiement' })

  const customerIds = [p.quickbooks_customer_id, p.quickbooks_customer_id_usd].filter(Boolean).map(String)

  try {
    const data = await qbGet(`/${entityType.toLowerCase()}/${encodeURIComponent(qbId)}`)
    const entity = data[entityType]
    if (!entity) return res.status(502).json({ error: `QB n'a pas retourné de ${entityType} ${qbId}` })

    let acct = null
    if (entityType === 'Deposit') {
      const line = (entity.Line || []).find(l =>
        l.DepositLineDetail?.Entity?.value && customerIds.includes(String(l.DepositLineDetail.Entity.value))
      ) || (entity.Line || []).find(l => l.DepositLineDetail?.AccountRef)
      acct = line?.DepositLineDetail?.AccountRef
    } else if (entityType === 'JournalEntry') {
      const line = (entity.Line || []).find(l =>
        l.JournalEntryLineDetail?.PostingType === 'Credit'
        && l.JournalEntryLineDetail?.Entity?.EntityRef?.value
        && customerIds.includes(String(l.JournalEntryLineDetail.Entity.EntityRef.value))
      ) || (entity.Line || []).find(l => l.JournalEntryLineDetail?.PostingType === 'Credit')
      acct = line?.JournalEntryLineDetail?.AccountRef
    } else if (entityType === 'SalesReceipt') {
      // SR : pas de compte direct, on remonte le 1er Item référencé.
      const itemRef = (entity.Line || []).find(l => l.SalesItemLineDetail?.ItemRef?.name)?.SalesItemLineDetail?.ItemRef
      if (itemRef?.name) acct = { value: null, name: `Item: ${itemRef.name}` }
    }

    res.json({
      qb_entity_type: entityType,
      qb_id: qbId,
      credit_account_id: acct?.value ? String(acct.value) : null,
      credit_account_name: acct?.name || null,
    })
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

// DELETE /api/payments/:id — supprime une ligne payments (admin only, à utiliser
// avec prudence : ne supprime PAS l'écriture QB associée, à annuler manuellement).
router.delete('/:id', (req, res) => {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin requis' })
  const p = db.prepare(
    'SELECT id, facture_id, qb_deposit_id, qb_journal_entry_id, qb_payment_id FROM payments WHERE id = ?'
  ).get(req.params.id)
  if (!p) return res.status(404).json({ error: 'Paiement introuvable' })
  db.prepare('DELETE FROM payments WHERE id = ?').run(req.params.id)
  if (p.facture_id) recomputeFactureBalance(p.facture_id)
  const qbId = p.qb_deposit_id || p.qb_journal_entry_id || p.qb_payment_id
  res.json({
    ok: true,
    qb_deposit_id: p.qb_deposit_id,
    qb_journal_entry_id: p.qb_journal_entry_id,
    qb_payment_id: p.qb_payment_id,
    warning: qbId ? 'Écriture QB associée non supprimée — annuler manuellement dans QB' : null,
  })
})

export default router
