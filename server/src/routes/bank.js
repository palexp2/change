// Rapprochement bancaire : comptes, import de relevés collés, matching et
// validation. Voir services/bankReconciliation.js pour la logique.
import { Router } from 'express'
import { randomUUID } from 'crypto'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { qbEntityUrl } from '../connectors/quickbooks.js'
import { buildPartialUpdate } from '../utils/partialUpdate.js'
import {
  parseStatementText, importTransactions, findCandidates,
  autoMatchAccount, refreshStatuses, deriveStatus,
} from '../services/bankReconciliation.js'
import { listQbBankAccounts, linkAccountToQb, storedQbUrl } from '../services/bankQbLink.js'
import { summarizeAccount, compareWithQb } from '../services/bankReconcileSummary.js'

const router = Router()
router.use(requireAuth)

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`

function getAccount(id) {
  return db.prepare('SELECT * FROM bank_accounts WHERE id=? AND deleted_at IS NULL').get(id)
}

// ── Comptes ──────────────────────────────────────────────────────────────────

router.get('/accounts', (req, res) => {
  const accounts = db.prepare(`
    SELECT a.*,
      (SELECT COUNT(*) FROM bank_transactions t WHERE t.account_id=a.id AND t.deleted_at IS NULL) AS txn_count,
      (SELECT COUNT(*) FROM bank_transactions t WHERE t.account_id=a.id AND t.deleted_at IS NULL AND t.status='a_traiter') AS a_traiter_count,
      (SELECT MAX(t.txn_date) FROM bank_transactions t WHERE t.account_id=a.id AND t.deleted_at IS NULL) AS last_txn_date
    FROM bank_accounts a WHERE a.deleted_at IS NULL
    ORDER BY a.sort_order, a.name COLLATE NOCASE
  `).all()
  res.json(accounts)
})

const ACCOUNT_FIELDS = ['name', 'kind', 'currency', 'account_number', 'institution', 'sort_order', 'active', 'qb_account_id']

router.post('/accounts', (req, res) => {
  const name = String(req.body.name || '').trim()
  if (!name) return res.status(400).json({ error: 'name requis' })
  if (req.body.kind && !['bank', 'card'].includes(req.body.kind)) return res.status(400).json({ error: 'kind invalide (bank, card)' })
  const id = randomUUID()
  try {
    db.prepare(`
      INSERT INTO bank_accounts (id, name, kind, currency, account_number, institution, sort_order)
      VALUES (?,?,?,?,?,?,?)
    `).run(id, name, req.body.kind || 'bank', String(req.body.currency || 'CAD').toUpperCase(),
      req.body.account_number || null, req.body.institution || null, Number(req.body.sort_order) || 0)
  } catch (e) {
    if (/UNIQUE/.test(String(e.message))) return res.status(409).json({ error: 'Un compte porte déjà ce nom' })
    throw e
  }
  res.status(201).json(getAccount(id))
})

router.patch('/accounts/:id', (req, res) => {
  if (!getAccount(req.params.id)) return res.status(404).json({ error: 'Not found' })
  if ('kind' in req.body && !['bank', 'card'].includes(req.body.kind)) return res.status(400).json({ error: 'kind invalide (bank, card)' })
  const { setClause, values, error } = buildPartialUpdate(req.body, {
    allowed: ACCOUNT_FIELDS, nonNullable: new Set(['name', 'kind', 'currency']),
  })
  if (error) return res.status(400).json({ error })
  if (setClause) {
    db.prepare(`UPDATE bank_accounts SET ${setClause}, updated_at=${NOW} WHERE id=?`).run(...values, req.params.id)
  }
  res.json(getAccount(req.params.id))
})

router.delete('/accounts/:id', (req, res) => {
  if (!getAccount(req.params.id)) return res.status(404).json({ error: 'Not found' })
  db.prepare(`UPDATE bank_accounts SET deleted_at=${NOW} WHERE id=?`).run(req.params.id)
  res.json({ ok: true })
})

// ── Transactions ─────────────────────────────────────────────────────────────

// Liste d'un compte. Rafraîchit d'abord les statuts (une facture poussée à QB
// depuis le dernier passage fait avancer les lignes bleu → jaune toute seule).
router.get('/accounts/:id/transactions', (req, res) => {
  const account = getAccount(req.params.id)
  if (!account) return res.status(404).json({ error: 'Not found' })
  refreshStatuses(account.id)
  const rows = db.prepare(`
    SELECT t.*, u.name AS reconciled_by_name,
           COALESCE(NULLIF(t.details, ''), t.description) AS label
    FROM bank_transactions t
    LEFT JOIN users u ON u.id = t.reconciled_by
    WHERE t.account_id=? AND t.deleted_at IS NULL
    ORDER BY t.txn_date DESC, t.created_at DESC
  `).all(account.id)
  // Libellé du document apparié pour affichage direct dans le tableau, et
  // lien direct vers la transaction QB si le document a été publié.
  const achatLabel = db.prepare('SELECT vendor, total_cad AS total, quickbooks_id, type FROM achats_fournisseurs WHERE id=?')
  const receiptLabel = db.prepare('SELECT company AS vendor, total, quickbooks_id, quickbooks_type FROM sale_receipts WHERE id=?')
  const payoutQb = db.prepare('SELECT qb_deposit_id FROM stripe_payouts WHERE id=?')
  for (const t of rows) {
    // Lien direct trouvé via le grand livre QB (linkAccountToQb) — prioritaire,
    // et seul disponible pour l'historique rapproché sans document ERP.
    t.qb_url = storedQbUrl(t)
    if (!t.matched_id) continue
    let doc = null
    if (t.matched_type === 'achat') {
      doc = achatLabel.get(t.matched_id)
      if (doc?.quickbooks_id) t.qb_url = qbEntityUrl(doc.type === 'bill' ? 'bill' : 'expense', doc.quickbooks_id)
    } else if (t.matched_type === 'receipt') {
      doc = receiptLabel.get(t.matched_id)
      if (doc?.quickbooks_id) {
        const entity = doc.quickbooks_type === 'bill' ? 'bill'
          : doc.quickbooks_type === 'cc_credit' ? 'creditcardcredit'
          : 'expense'
        t.qb_url = qbEntityUrl(entity, doc.quickbooks_id)
      }
    } else if (t.matched_type === 'stripe_payout') {
      doc = { vendor: 'Payout Stripe' }
      const depositId = payoutQb.get(t.matched_id)?.qb_deposit_id
      if (depositId) t.qb_url = qbEntityUrl('deposit', depositId)
    }
    t.matched_label = doc?.vendor || null
  }
  res.json(rows)
})

// Import par collage. body: { text } (tab-séparé avec entêtes) ou { rows } déjà parsés.
router.post('/accounts/:id/import', (req, res) => {
  const account = getAccount(req.params.id)
  if (!account) return res.status(404).json({ error: 'Not found' })
  let rows = []
  let parseErrors = []
  if (Array.isArray(req.body.rows)) {
    rows = req.body.rows
  } else {
    const parsed = parseStatementText(req.body.text)
    rows = parsed.rows
    parseErrors = parsed.errors
  }
  if (!rows.length) {
    return res.status(400).json({ error: parseErrors[0] || 'Aucune transaction reconnue', parseErrors })
  }
  for (const r of rows) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.txn_date || '')) || !Number.isFinite(Number(r.amount))) {
      return res.status(400).json({ error: 'Chaque ligne doit avoir txn_date (YYYY-MM-DD) et amount' })
    }
  }
  // Mode aperçu : parse + dédup simulée, sans écrire.
  if (req.body.preview) {
    return res.json({ preview: true, rows, parseErrors })
  }
  const result = importTransactions(account.id, rows, req.user.id)
  const auto = autoMatchAccount(account.id)
  res.status(201).json({ ...result, parseErrors, autoMatched: auto.matched })
})

// Comptes Banque / Carte de crédit côté QuickBooks (pour mapper qb_account_id).
router.get('/qb-accounts', async (req, res) => {
  try {
    res.json(await listQbBankAccounts())
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

// Apparie les transactions du compte à leurs transactions QuickBooks via le
// grand livre (montant exact + date ±4 jours). Idempotent : ne touche que les
// lignes sans qb_txn_id.
router.post('/accounts/:id/qb-link', async (req, res) => {
  const account = getAccount(req.params.id)
  if (!account) return res.status(404).json({ error: 'Not found' })
  if (!account.qb_account_id) return res.status(400).json({ error: 'Aucun compte QuickBooks mappé pour ce compte' })
  try {
    res.json(await linkAccountToQb(account.id))
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

// Relance le matching automatique sur les lignes à traiter.
router.post('/accounts/:id/automatch', (req, res) => {
  const account = getAccount(req.params.id)
  if (!account) return res.status(404).json({ error: 'Not found' })
  res.json(autoMatchAccount(account.id))
})

// Solde calculé du compte + anomalies (chaîne des soldes, doublons). Local et
// instantané : aucun appel QuickBooks. Voir services/bankReconcileSummary.js.
router.get('/accounts/:id/summary', (req, res) => {
  const account = getAccount(req.params.id)
  if (!account) return res.status(404).json({ error: 'Not found' })
  refreshStatuses(account.id)
  res.json(summarizeAccount(account.id))
})

// Comparaison avec QuickBooks : solde QB à la date du relevé, écart, et la
// liste des transactions qui l'expliquent de part et d'autre. Appelle QB.
router.get('/accounts/:id/qb-compare', async (req, res) => {
  const account = getAccount(req.params.id)
  if (!account) return res.status(404).json({ error: 'Not found' })
  const iso = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : undefined)
  try {
    res.json(await compareWithQb(account.id, { from: iso(req.query.from), to: iso(req.query.to) }))
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

// Rapprochement complet en une action : appariement aux documents ERP puis
// liaison au grand livre QuickBooks, avec le résumé recalculé en retour.
router.post('/accounts/:id/reconcile-auto', async (req, res) => {
  const account = getAccount(req.params.id)
  if (!account) return res.status(404).json({ error: 'Not found' })
  const auto = autoMatchAccount(account.id)
  let qb = null
  let qbError = null
  if (account.qb_account_id) {
    try { qb = await linkAccountToQb(account.id) } catch (e) { qbError = e.message }
  }
  res.json({ ...auto, qb, qbError, summary: summarizeAccount(account.id) })
})

function getTxn(id) {
  return db.prepare('SELECT * FROM bank_transactions WHERE id=? AND deleted_at IS NULL').get(id)
}

// Candidats de matching (pour le drawer de suggestions).
router.get('/transactions/:id/suggestions', (req, res) => {
  const txn = getTxn(req.params.id)
  if (!txn) return res.status(404).json({ error: 'Not found' })
  res.json(findCandidates(txn).slice(0, 8))
})

// Appariement manuel. body: { matched_type, matched_id } — ou null pour délier.
router.post('/transactions/:id/match', (req, res) => {
  const txn = getTxn(req.params.id)
  if (!txn) return res.status(404).json({ error: 'Not found' })
  const { matched_type: type, matched_id: id } = req.body
  if (type === null || id === null) {
    db.prepare(`
      UPDATE bank_transactions
      SET matched_type=NULL, matched_id=NULL, match_method=NULL, match_confidence=NULL,
          reconciled_at=NULL, reconciled_by=NULL, status='a_traiter', updated_at=${NOW}
      WHERE id=?
    `).run(txn.id)
    return res.json(getTxn(txn.id))
  }
  if (!['achat', 'receipt', 'stripe_payout'].includes(type) || !id) {
    return res.status(400).json({ error: 'matched_type (achat, receipt, stripe_payout) et matched_id requis' })
  }
  const status = deriveStatus({ ...txn, matched_type: type, matched_id: String(id), reconciled_at: null })
  db.prepare(`
    UPDATE bank_transactions
    SET matched_type=?, matched_id=?, match_method='manuel', match_confidence=1,
        reconciled_at=NULL, reconciled_by=NULL, status=?, updated_at=${NOW}
    WHERE id=?
  `).run(type, String(id), status, txn.id)
  res.json(getTxn(txn.id))
})

// Rapprochement (vert) — en lot. body: { ids: [...] }. `unreconcile: true` pour annuler.
router.post('/transactions/reconcile', (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : []
  if (!ids.length) return res.status(400).json({ error: 'ids requis' })
  const un = req.body.unreconcile === true
  const stmt = un
    ? db.prepare(`UPDATE bank_transactions SET reconciled_at=NULL, reconciled_by=NULL, status='a_traiter', updated_at=${NOW} WHERE id=? AND deleted_at IS NULL`)
    : db.prepare(`UPDATE bank_transactions SET reconciled_at=${NOW}, reconciled_by=?, status='rapproche', updated_at=${NOW} WHERE id=? AND deleted_at IS NULL`)
  let changed = 0
  const tx = db.transaction(() => {
    for (const id of ids) {
      changed += un ? stmt.run(id).changes : stmt.run(req.user.id, id).changes
    }
  })
  tx()
  // Les statuts dé-rapprochés retombent sur la valeur dérivée au prochain GET.
  res.json({ changed })
})

// Édition libre : commentaire, statut ignore, date/montant (correction de collage).
const TXN_FIELDS = ['comment', 'txn_date', 'description', 'details', 'reference', 'amount', 'balance']

router.patch('/transactions/:id', (req, res) => {
  const txn = getTxn(req.params.id)
  if (!txn) return res.status(404).json({ error: 'Not found' })
  if ('status' in req.body) {
    if (!['ignore', 'a_traiter'].includes(req.body.status)) {
      return res.status(400).json({ error: 'Seuls les statuts ignore et a_traiter sont éditables directement' })
    }
    db.prepare(`UPDATE bank_transactions SET status=?, updated_at=${NOW} WHERE id=?`).run(req.body.status, txn.id)
  }
  const { setClause, values, error } = buildPartialUpdate(req.body, {
    allowed: TXN_FIELDS, nonNullable: new Set(['txn_date', 'amount']),
  })
  if (error) return res.status(400).json({ error })
  if (setClause) {
    db.prepare(`UPDATE bank_transactions SET ${setClause}, updated_at=${NOW} WHERE id=?`).run(...values, txn.id)
  }
  res.json(getTxn(txn.id))
})

router.delete('/transactions/:id', (req, res) => {
  const txn = getTxn(req.params.id)
  if (!txn) return res.status(404).json({ error: 'Not found' })
  db.prepare(`UPDATE bank_transactions SET deleted_at=${NOW} WHERE id=?`).run(txn.id)
  res.json({ ok: true })
})

// ── Sync du fichier TRX_Orisha (Drive) ───────────────────────────────────────

// État de la sync automatique : automation active ? dernier passage, anomalies.
router.get('/trx-sheet/status', async (req, res) => {
  const { trxSheetStatus } = await import('../services/bankTrxSheet.js')
  res.json(trxSheetStatus())
})

// Sync immédiate. body: { dryRun: true } pour simuler sans écrire ni alerter.
router.post('/trx-sheet/sync', async (req, res) => {
  const { syncTrxSheet } = await import('../services/bankTrxSheet.js')
  try {
    res.json(await syncTrxSheet({ trigger: 'manual', apply: req.body?.dryRun !== true, userId: req.user.id }))
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

// Historique des imports d'un compte.
router.get('/accounts/:id/imports', (req, res) => {
  if (!getAccount(req.params.id)) return res.status(404).json({ error: 'Not found' })
  const rows = db.prepare(`
    SELECT b.*, u.name AS created_by_name FROM bank_import_batches b
    LEFT JOIN users u ON u.id = b.created_by
    WHERE b.account_id=? ORDER BY b.created_at DESC LIMIT 50
  `).all(req.params.id)
  res.json(rows)
})

export default router
