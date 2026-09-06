import { Router } from 'express'
import { newRecordId } from '../utils/recordId.js'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { postPaymentDeposit, previewPaymentDeposit, processRefund } from '../services/quickbooks.js'
import { qbEntityUrl, qbGet } from '../connectors/quickbooks.js'
import { recomputeFactureBalance } from '../services/factureBalance.js'
import { emitFacture, emitFacturePaymentsChanged } from '../services/realtimeEmitters.js'
import { logSync } from '../services/syncLog.js'
import { naiveLocalToUtcIso } from '../utils/datetime.js'
import { buildPartialUpdate } from '../utils/partialUpdate.js'
import { getWritableCustomColumns, refusedAirtablePullKeys, AIRTABLE_PULL_EDIT_ERROR } from '../services/customFieldWritability.js'
import { parsePage } from '../utils/pagination.js'

// Relation de lecture des paiements : la VUE `payments_v` si elle existe (elle
// expose en plus les champs custom virtuels — formule/lookup/rollup), sinon la
// table physique `payments` (qui porte déjà les champs custom de kind='data').
function paymentsReadRelation() {
  const hasView = db.prepare("SELECT 1 FROM sqlite_master WHERE type='view' AND name='payments_v'").get()
  return hasView ? 'payments_v' : 'payments'
}

const router = Router()
router.use(requireAuth)

const VALID_METHODS = new Set(['cheque', 'virement_bancaire', 'interac', 'comptant', 'autre'])
const VALID_CURRENCIES = new Set(['CAD', 'USD'])
// Motifs de skip QB. Obligatoire dès qu'un paiement est créé avec skip_qb=true :
// rend chaque skip auditable (skip légitime vs paiement orphelin jamais
// comptabilisé). Tenu synchrone avec QB_SKIP_REASONS côté client
// (FacturePaymentsSection.jsx).
const VALID_QB_SKIP_REASONS = new Set(['deja_poste_payout', 'saisi_manuellement_qb', 'hors_bande', 'autre'])

// GET /api/payments — liste centralisée de TOUS les paiements et remboursements
// (page « Paiements »). Deux sources fusionnées :
//   1. Lignes réelles de la table `payments` : encaissements/remboursements
//      hors-Stripe saisis manuellement + refunds Stripe + paiements Stripe qui
//      ont bel et bien une ligne payments.
//   2. Lignes Stripe synthétiques : la majorité des encaissements Stripe ne
//      créent PAS de ligne payments (le push QB se fait au payout). On les
//      reconstruit depuis `factures.paid_at` — même logique que la vue par
//      facture (GET /facture/:factureId) — pour que la page reflète vraiment
//      l'argent entré, pas seulement les saisies manuelles. Ces lignes sont
//      flagées `synthetic: true` (lecture seule côté client).
// Contrat de pagination identique aux autres listes : { data, total, page, limit }
// avec support `limit=all` (utilisé par loadProgressive).
router.get('/', (req, res) => {
  const { direction, method } = req.query
  const { page, limit, limitAll, limitVal, offset } = parsePage(req.query, 50)

  // p.* : inclut les colonnes natives ET les champs personnalisés (colonnes
  // physiques cf_* + colonnes virtuelles exposées par la vue payments_v). La page
  // « Paiements » peut ainsi afficher n'importe quelle colonne custom ajoutée.
  const real = db.prepare(`
    SELECT p.*,
           f.document_number, f.kind, c.id AS company_id, c.name AS company_name,
           0 AS synthetic
    FROM ${paymentsReadRelation()} p
    JOIN factures f ON f.id = p.facture_id
    LEFT JOIN companies c ON c.id = f.company_id
  `).all()

  // Encaissements Stripe sans ligne payments 'in' → reconstitués depuis paid_at.
  // Exclut les factures à 0 $ (essais gratuits) et les Void, comme direct-deposits.
  const synthetic = db.prepare(`
    SELECT 'synthetic:stripe:' || f.id AS id, f.id AS facture_id, 'in' AS direction,
           'stripe' AS method, f.paid_at AS received_at,
           COALESCE(f.paid_amount, f.total_amount) AS amount,
           UPPER(COALESCE(f.currency, 'CAD')) AS currency,
           NULL AS amount_cad, NULL AS exchange_rate, NULL AS qb_deposit_id,
           NULL AS qb_journal_entry_id, NULL AS qb_payment_id, 0 AS qb_skipped,
           NULL AS qb_skip_reason,
           'Paiement Stripe — écriture QB posée au payout' AS notes,
           f.paid_at AS created_at,
           f.document_number, f.kind, c.id AS company_id, c.name AS company_name,
           1 AS synthetic
    FROM factures f
    LEFT JOIN companies c ON c.id = f.company_id
    WHERE f.paid_at IS NOT NULL
      AND COALESCE(f.status, '') != 'Void'
      AND f.total_amount > 0
      AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.facture_id = f.id AND p.direction = 'in')
  `).all()

  let merged = [...real, ...synthetic]
  for (const r of merged) r.qb_skipped = !!r.qb_skipped
  if (direction === 'in' || direction === 'out') merged = merged.filter(r => r.direction === direction)
  if (method) merged = merged.filter(r => r.method === method)
  merged.sort((a, b) => {
    const da = a.received_at || a.created_at || ''
    const db2 = b.received_at || b.created_at || ''
    return db2.localeCompare(da)
  })

  const total = merged.length
  const sliced = limitAll ? merged : merged.slice(offset, offset + limitVal)
  res.json({ data: sliced, total, page: parseInt(page), limit: limitAll ? 'all' : parseInt(limit) })
})

// GET /api/payments/direct-deposits — vue centralisée des encaissements reçus
// HORS payouts Stripe (virement, chèque, Interac, comptant). Alimente la
// sous-section « Dépôts directs » de la page Stripe Payouts :
//   - deposits   : lignes payments direction='in' hors Stripe, avec statut QB
//                  (Deposit poussé / skip volontaire / échec à re-tenter)
//   - candidates : factures marquées payées hors bande (paid_at posé sans
//                  charge ni payment_intent Stripe → l'argent est entré
//                  directement en banque) sans encaissement saisi — restent à
//                  comptabiliser via POST /api/payments (Deposit QB automatique).
router.get('/direct-deposits', (req, res) => {
  const deposits = db.prepare(`
    SELECT p.id, p.facture_id, p.method, p.received_at, p.amount, p.currency,
           p.amount_cad, p.exchange_rate, p.qb_deposit_id, p.qb_journal_entry_id,
           p.qb_payment_id, p.qb_skipped, p.qb_skip_reason,
           p.qb_credit_account_id, p.qb_credit_account_name, p.notes,
           f.document_number, f.kind, c.id AS company_id, c.name AS company_name
    FROM payments p
    JOIN factures f ON f.id = p.facture_id
    LEFT JOIN companies c ON c.id = f.company_id
    WHERE p.direction = 'in' AND p.method != 'stripe'
    ORDER BY p.received_at DESC, p.created_at DESC
  `).all()
  for (const r of deposits) {
    r.qb_skipped = !!r.qb_skipped
    r.qb_deposit_url = r.qb_deposit_id ? qbEntityUrl('deposit', r.qb_deposit_id) : null
    r.qb_journal_entry_url = r.qb_journal_entry_id ? qbEntityUrl('journal', r.qb_journal_entry_id) : null
    r.qb_payment_url = r.qb_payment_id ? qbEntityUrl('recvpayment', r.qb_payment_id) : null
  }

  // total_amount > 0 : les factures d'abonnement à 0 $ (essais/gratuites) sont
  // marquées payées par Stripe sans le moindre encaissement — rien à comptabiliser.
  const candidates = db.prepare(`
    SELECT f.id, f.document_number, f.kind, f.status, f.currency, f.total_amount,
           f.paid_at, f.document_date, c.id AS company_id, c.name AS company_name
    FROM factures f
    LEFT JOIN companies c ON c.id = f.company_id
    WHERE f.paid_at IS NOT NULL
      AND (f.paid_charge_id IS NULL OR f.paid_charge_id = '')
      AND (f.paid_payment_intent IS NULL OR f.paid_payment_intent = '')
      AND COALESCE(f.status, '') != 'Void'
      AND f.total_amount > 0
      AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.facture_id = f.id AND p.direction = 'in')
    ORDER BY f.paid_at DESC
  `).all()

  res.json({ deposits, candidates })
})

// POST /api/payments/preview-deposit — aperçu du Deposit QB qu'un encaissement
// hors-Stripe produirait, SANS rien écrire (ni QB, ni DB). Même contrat que
// l'« Aperçu Deposit » des Stripe payouts : { deposit, summary, warnings }.
// Body : { facture_id, amount, currency, method, received_at }.
router.post('/preview-deposit', async (req, res) => {
  const { facture_id, amount, currency, method, received_at } = req.body || {}
  if (!facture_id) return res.status(400).json({ error: 'facture_id requis' })
  const amt = Number(amount)
  if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'amount doit être un nombre > 0' })
  const cur = String(currency || 'CAD').toUpperCase()
  if (!VALID_CURRENCIES.has(cur)) return res.status(400).json({ error: 'currency doit être CAD ou USD' })
  const facture = db.prepare('SELECT id FROM factures WHERE id = ?').get(facture_id)
  if (!facture) return res.status(404).json({ error: 'Facture introuvable' })
  try {
    const preview = await previewPaymentDeposit({
      factureId: facture_id,
      amount: amt,
      currency: cur,
      method: VALID_METHODS.has(method) ? method : 'autre',
      receivedAt: received_at || undefined,
    })
    res.json(preview)
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// GET /api/payments/direct-deposits/:id — détail d'un dépôt direct pour la page
// /depots-directs/:id (miroir du détail d'un Stripe payout). :id est soit un
// payment.id (dépôt comptabilisé), soit un facture.id (candidat à comptabiliser).
// Si la facture a déjà un encaissement hors-Stripe, renvoie { kind:'redirect' }
// vers le payment pour que la page bascule en mode « comptabilisé ».
router.get('/direct-deposits/:id', (req, res) => {
  const p = db.prepare(`
    SELECT p.*, f.document_number, f.kind, f.total_amount AS facture_total_amount,
           f.paid_at, f.document_date, c.id AS company_id, c.name AS company_name
    FROM payments p
    JOIN factures f ON f.id = p.facture_id
    LEFT JOIN companies c ON c.id = f.company_id
    WHERE p.id = ?
  `).get(req.params.id)
  if (p) {
    p.qb_skipped = !!p.qb_skipped
    p.qb_deposit_url = p.qb_deposit_id ? qbEntityUrl('deposit', p.qb_deposit_id) : null
    p.qb_journal_entry_url = p.qb_journal_entry_id ? qbEntityUrl('journal', p.qb_journal_entry_id) : null
    p.qb_payment_url = p.qb_payment_id ? qbEntityUrl('recvpayment', p.qb_payment_id) : null
    return res.json({ kind: 'deposit', deposit: p })
  }

  const f = db.prepare(`
    SELECT f.id, f.document_number, f.kind, f.status, f.currency, f.total_amount,
           f.paid_at, f.document_date, c.id AS company_id, c.name AS company_name
    FROM factures f
    LEFT JOIN companies c ON c.id = f.company_id
    WHERE f.id = ?
  `).get(req.params.id)
  if (!f) return res.status(404).json({ error: 'Dépôt introuvable' })
  const existing = db.prepare(
    "SELECT id FROM payments WHERE facture_id = ? AND direction = 'in' AND method != 'stripe' ORDER BY created_at DESC LIMIT 1"
  ).get(f.id)
  if (existing) return res.json({ kind: 'redirect', payment_id: existing.id })
  res.json({ kind: 'candidate', candidate: f })
})

// PATCH /api/payments/:id/qb-ref — rattache une écriture QB EXISTANTE (saisie à la
// main dans QuickBooks avant que le push automatique existe) à un paiement, pour
// que la ligne affiche son lien QB au lieu de « saisi à la main »/« à pousser ».
// Body : { qb_deposit_id } ou { qb_payment_id } (receive-payment QB). L'entité est
// vérifiée dans QB avant d'être rattachée — un id inexistant est refusé.
router.patch('/:id/qb-ref', async (req, res) => {
  const p = db.prepare('SELECT id, facture_id FROM payments WHERE id = ?').get(req.params.id)
  if (!p) return res.status(404).json({ error: 'Paiement introuvable' })
  const { qb_deposit_id, qb_payment_id } = req.body || {}
  if (!qb_deposit_id && !qb_payment_id) {
    return res.status(400).json({ error: 'qb_deposit_id ou qb_payment_id requis' })
  }
  if (qb_deposit_id && qb_payment_id) {
    return res.status(400).json({ error: 'Fournir un seul id à la fois' })
  }
  const entity = qb_deposit_id ? 'Deposit' : 'Payment'
  const qbId = String(qb_deposit_id || qb_payment_id)
  try {
    await qbGet(`/${entity.toLowerCase()}/${qbId}?minorversion=65`)
  } catch (e) {
    return res.status(400).json({ error: `${entity} #${qbId} introuvable dans QuickBooks : ${e.message}` })
  }
  const col = qb_deposit_id ? 'qb_deposit_id' : 'qb_payment_id'
  db.prepare(`
    UPDATE payments SET ${col} = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(qbId, req.params.id)
  const url = qbEntityUrl(qb_deposit_id ? 'deposit' : 'recvpayment', qbId)
  emitFacturePaymentsChanged(p.facture_id, req.user?.id)
  res.json({ ok: true, [col]: qbId, qb_url: url })
})

// PATCH /api/payments/:id — met à jour UNIQUEMENT les champs personnalisés
// (colonnes cf_*) d'un paiement. Les colonnes natives (montant, méthode, refs QB,
// dates…) ne sont jamais modifiables ici : elles sont pilotées par la logique
// comptable (webhooks Stripe, postPaymentDeposit/processRefund) et une édition
// libre corromprait le suivi des AR. Alimente l'édition inline « tableur » des
// colonnes custom de la page Paiements.
router.patch('/:id', (req, res) => {
  // Les lignes Stripe synthétiques n'ont pas de row `payments` réelle → aucune
  // valeur custom ne peut y être stockée.
  if (String(req.params.id).startsWith('synthetic:')) {
    return res.status(400).json({ error: 'Ligne Stripe synthétique — pas de champ personnalisé éditable' })
  }
  const existing = db.prepare('SELECT id FROM payments WHERE id = ?').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Paiement introuvable' })

  // Whitelist d'update : seules les colonnes custom ÉDITABLES (règle unique —
  // services/customFieldWritability.js). Un champ Airtable en import seul est
  // refusé en 400 explicite plutôt qu'ignoré en silence par buildPartialUpdate.
  if (refusedAirtablePullKeys('payments', req.body).length > 0) {
    return res.status(400).json({ error: AIRTABLE_PULL_EDIT_ERROR })
  }
  const customCols = getWritableCustomColumns('payments').map(c => c.column_name)
  if (customCols.length === 0) {
    return res.status(400).json({ error: 'Aucun champ personnalisé à modifier sur les paiements' })
  }
  const { setClause, values, error } = buildPartialUpdate(req.body, { allowed: customCols })
  if (error) return res.status(400).json({ error })
  if (setClause) {
    db.prepare(`UPDATE payments SET ${setClause}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
      .run(...values, req.params.id)
  }
  // Relit depuis la vue si elle existe → renvoie aussi les champs virtuels recalculés.
  const updated = db.prepare(`SELECT * FROM ${paymentsReadRelation()} WHERE id = ?`).get(req.params.id)
  res.json(updated)
})

// GET /api/payments/facture/:factureId — liste les paiements/refunds d'une facture
router.get('/facture/:factureId', (req, res) => {
  const rows = db.prepare(`
    SELECT id, facture_id, direction, method, received_at, amount, currency,
           amount_cad, exchange_rate, stripe_balance_tx_id, stripe_charge_id,
           stripe_refund_id, qb_payment_id, qb_journal_entry_id, qb_deposit_id,
           qb_skipped, qb_skip_reason, qb_credit_account_id, qb_credit_account_name, notes,
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
    r.qb_payment_url = r.qb_payment_id ? qbEntityUrl('recvpayment', r.qb_payment_id) : null
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
  const { facture_id, direction, method, received_at, amount, currency, notes, skip_qb, qb_skip_reason, clear_paid_status } = req.body || {}

  if (!facture_id) return res.status(400).json({ error: 'facture_id requis' })
  if (direction !== 'in' && direction !== 'out') return res.status(400).json({ error: 'direction doit être "in" ou "out"' })
  if (!VALID_METHODS.has(method)) return res.status(400).json({ error: `method invalide (attendu: ${[...VALID_METHODS].join(', ')})` })
  const amt = Number(amount)
  if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'amount doit être un nombre > 0' })
  const cur = String(currency || 'CAD').toUpperCase()
  if (!VALID_CURRENCIES.has(cur)) return res.status(400).json({ error: 'currency doit être CAD ou USD' })
  // Skip QB → motif obligatoire et énuméré. Un skip sans motif rendrait
  // impossible de distinguer un skip légitime d'un paiement jamais comptabilisé.
  if (skip_qb && !VALID_QB_SKIP_REASONS.has(qb_skip_reason)) {
    return res.status(400).json({ error: `qb_skip_reason requis et doit être l'un de : ${[...VALID_QB_SKIP_REASONS].join(', ')}` })
  }
  // Pas de skip → on n'enregistre aucun motif (le motif n'a de sens que pour un skip).
  const skipReason = skip_qb ? qb_skip_reason : null
  // Une date-only "YYYY-MM-DD" venue d'un <input type="date"> représente une
  // journée calendaire locale (Montréal), pas un instant UTC. La parser via
  // new Date() la traite comme minuit UTC, ce qui s'affiche en J-1 20:00 en EDT.
  // On force l'interprétation locale → conversion UTC.
  let receivedIso
  if (received_at) {
    const s = String(received_at)
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      receivedIso = naiveLocalToUtcIso(`${s}T00:00:00`)
    } else {
      receivedIso = new Date(s).toISOString()
    }
  } else {
    receivedIso = new Date().toISOString()
  }
  if (!receivedIso || Number.isNaN(Date.parse(receivedIso))) return res.status(400).json({ error: 'received_at invalide' })

  const facture = db.prepare(
    'SELECT id, paid_at, paid_charge_id, paid_payment_intent, due_date FROM factures WHERE id = ?'
  ).get(facture_id)
  if (!facture) return res.status(404).json({ error: 'Facture introuvable' })

  // clear_paid_status=true : la facture est marquée payée hors bande dans Stripe
  // (paid_at posé sans charge ni payment_intent) et on saisit ici l'encaissement
  // réel. On efface l'état « payé » hérité de Stripe dans la MÊME transaction que
  // l'INSERT — sinon recomputeFactureBalance ignore le paiement (paid_at fait
  // autorité). Équivalent atomique et non-admin du POST /admin/factures/:id/
  // clear-paid-status, strictement borné au cas hors bande : une facture avec une
  // vraie charge Stripe est refusée (son état « payé » est authentique).
  if (clear_paid_status) {
    if (direction !== 'in') return res.status(400).json({ error: 'clear_paid_status ne s\'applique qu\'à un paiement reçu (direction=in)' })
    if (facture.paid_at && (facture.paid_charge_id || facture.paid_payment_intent)) {
      return res.status(409).json({ error: 'Facture payée via Stripe (charge/payment_intent présent) — état « payé » authentique, clear_paid_status refusé' })
    }
  }

  const id = newRecordId()
  // Atomique : l'INSERT du paiement et le recompute du solde de la facture
  // doivent réussir ou échouer ensemble. Sinon, si le recompute échoue après
  // l'INSERT, la ligne payment existe mais factures.balance_due reste périmé
  // (solde faux affiché jusqu'au prochain paiement). recomputeFactureBalance
  // est purement synchrone (lectures + UPDATE SQLite), donc compatible avec
  // db.transaction() de better-sqlite3.
  const insertAndRecompute = db.transaction(() => {
    if (clear_paid_status && facture.paid_at) {
      const today = new Date().toISOString().slice(0, 10)
      const nextStatus = (facture.due_date && facture.due_date < today) ? 'En retard' : 'À payer'
      db.prepare(`
        UPDATE factures
        SET paid_at = NULL,
            paid_amount = NULL,
            paid_charge_id = NULL,
            paid_payment_intent = NULL,
            status = CASE WHEN status IN ('Payé','Payée') THEN ? ELSE status END,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?
      `).run(nextStatus, facture_id)
    }
    db.prepare(`
      INSERT INTO payments (
        id, facture_id, direction, method, received_at, amount, currency,
        notes, created_by, qb_skipped, qb_skip_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, facture_id, direction, method, receivedIso, amt, cur, notes || null, req.user?.id || null, skip_qb ? 1 : 0, skipReason)

    // Synchronise factures.balance_due / status avec les paiements locaux. Sans
    // ça, une facture Stripe payée hors Stripe (Interac, virement…) garderait le
    // solde renvoyé par Stripe (qui ne sait rien du paiement local).
    recomputeFactureBalance(facture_id)
  })
  insertAndRecompute()

  // Pose l'écriture comptable QB (Deposit pour 'in', JE/RR pour 'out'). Si échec,
  // on retourne quand même 201 + le payload, avec un warning. La ligne payments
  // reste en DB sans qb_deposit_id (ou qb_payment_id pour les refunds) pour retry manuel.
  // skip_qb=true : l'écriture QB a déjà été postée manuellement (ex. facture Stripe
  // paid-out-of-band dont l'encaissement Interac a été saisi à la main dans QB).
  // La row payments existe pour la traçabilité ERP, mais on n'appelle pas QB.
  let qbResult = null
  let qbError = null
  if (!skip_qb) {
    const t0 = Date.now()
    try {
      qbResult = direction === 'in'
        ? await postPaymentDeposit(id)
        : await processRefund(id)
    } catch (err) {
      console.error(`payment QB ${direction} échouée pour ${id}:`, err.message)
      qbError = err.message
      // Trace l'échec dans sync_log : sans ça, une row payments sans qb_deposit_id
      // (ni qb_payment_id pour les refunds) devient invisible à l'audit si l'utilisateur
      // ferme le toast d'erreur. Même contrat de traçabilité que les autres opérations QB.
      logSync('quickbooks', 'manual', {
        status: 'error',
        error: `payment ${direction} ${id} (facture ${facture_id}): ${err.message}`,
        durationMs: Date.now() - t0,
      })
    }
  }

  const created = db.prepare('SELECT * FROM payments WHERE id = ?').get(id)
  if (qbResult?.qb_deposit_id) qbResult.qb_deposit_url = qbEntityUrl('deposit', qbResult.qb_deposit_id)
  // Temps réel : le solde dû et le statut viennent de changer, et la liste des
  // paiements de la fiche aussi. Émis après la pose QB pour que les refs QB
  // soient déjà en base quand le client recharge.
  emitFacturePaymentsChanged(facture_id, req.user?.id)
  emitFacture('updated', facture_id, req.user?.id)
  res.status(201).json({ payment: created, qb: qbResult, qb_error: qbError, qb_skipped: !!skip_qb, qb_skip_reason: skipReason })
})

// POST /api/payments/:id/retry-qb — re-tente la pose comptable QB pour un payment
// qui n'a ni Deposit, ni JE, ni SalesReceipt (échec précédent).
router.post('/:id/retry-qb', async (req, res) => {
  const p = db.prepare(
    'SELECT id, facture_id, direction, qb_deposit_id, qb_journal_entry_id, qb_payment_id, qb_skipped FROM payments WHERE id = ?'
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
    emitFacturePaymentsChanged(p.facture_id, req.user?.id)
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
  if (p.facture_id) {
    recomputeFactureBalance(p.facture_id)
    emitFacturePaymentsChanged(p.facture_id, req.user?.id)
    emitFacture('updated', p.facture_id, req.user?.id)
  }
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
