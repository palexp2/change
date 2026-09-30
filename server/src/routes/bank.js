// Rapprochement bancaire : comptes, import de relevés collés, matching et
// validation. Voir services/bankReconciliation.js pour la logique.
import { Router } from 'express'
import { newRecordId } from '../utils/recordId.js'
import db from '../db/database.js'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import { qbEntityUrl } from '../connectors/quickbooks.js'
import { buildPartialUpdate } from '../utils/partialUpdate.js'
import {
  parseStatementText, importTransactions, findCandidates,
  autoMatchAccount, refreshStatuses, deriveStatus,
} from '../services/bankReconciliation.js'
import { listQbBankAccounts, storedQbUrl } from '../services/bankQbLink.js'
import { touchBankTxns } from '../services/realtimeEmitters.js'
import { summarizeAccount, compareWithQb } from '../services/bankReconcileSummary.js'
import { verifyAccount } from '../services/bankQbVerify.js'
import { shiftDate } from '../utils/datetime.js'
import { planRepair, applyRepair } from '../services/bankImportRepair.js'
import { mergeSheetDuplicates, countSheetDuplicates } from '../services/plaidSync.js'
import { resolveVendorFromBankLabel, invalidateBankLabelCache } from '../services/scrapers/vendorFromBankLabel.js'
import { proposalsForTxn, proposalSummary, decode as decodeProposal } from '../services/bankProposals/store.js'
import { ruleForTxn } from '../services/bankRules/store.js'
import { acceptProposal, refuseProposal, getProposal, undoProposal } from '../services/bankProposals/apply.js'
import { isBatchAcceptable, PUBLISHES_TO_QB } from '../services/bankProposals/model.js'
import {
  BankActionError, suggestAddDefaults, addExpenseFromTxn,
  findTransferCandidates, linkTransfer, unlinkTransfer, pushTransferToQB,
} from '../services/bankActions.js'
import { matchedDocState, publishMatchedDoc } from '../services/bankMatchPublish.js'
import { findInvoiceCandidates } from '../services/bankInvoiceMatch.js'
import { findDocCandidates } from '../services/bankReceiptMatch.js'
import { getPaieRepartitionConfig } from '../services/paieRepartition.js'
import { labelMatchesPattern } from '../services/bankDebitLookup.js'
import { missingInvoiceAgeDays } from '../services/scrapers/invoiceNeeds.js'
import {
  listRequests as listInvoiceRequests, addRequests as addInvoiceRequests,
  removeRequest as removeInvoiceRequest, setInSend as setInvoiceRequestInSend,
  buildMessage as buildInvoiceRequestMessage, sendRequests as sendInvoiceRequests,
} from '../services/missingInvoiceRequests.js'
import {
  openReconcile, reconcileAccount, isRobotRunning, RECONCILE_AUTOMATION_ID, CAPTURE_DIR as QB_RECONCILE_CAPTURES,
} from '../services/qbReconcileRobot.js'
import { isSystemAutomationActive, logSystemRun } from '../services/systemAutomations.js'
import { monthCloseStatus } from '../services/bankMonthClose.js'
import { basename, join as joinPath } from 'path'
import { existsSync as fileExists } from 'fs'

const router = Router()
router.use(requireAuth)

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`

// Le fichier de suivi Google suit la page : dès qu'une ligne change ici, la
// recopie est annoncée (elle part quelques secondes plus tard, une seule fois
// pour toute une rafale — voir services/trxSheetMirror.js).
function mirrorSoon(reason) {
  import('../services/trxSheetMirror.js')
    .then((m) => m.mirrorOnChange(reason))
    .catch(() => { /* miroir indisponible : la page n'en dépend pas */ })
}

function getAccount(id) {
  return db.prepare('SELECT * FROM bank_accounts WHERE id=? AND deleted_at IS NULL').get(id)
}

// ── Comptes ──────────────────────────────────────────────────────────────────

// Le rapprochement commence au 1er janvier 2026 : 2025 est fermé, ses lignes
// ne s'affichent plus nulle part sur la page (demande de Charles, 2026-09-27).
const RECON_SINCE = '2026-01-01'

router.get('/accounts', (req, res) => {
  const accounts = db.prepare(`
    SELECT a.*,
      (SELECT COUNT(*) FROM bank_transactions t WHERE t.account_id=a.id AND t.deleted_at IS NULL AND t.txn_date >= '${RECON_SINCE}') AS txn_count,
      (SELECT COUNT(*) FROM bank_transactions t WHERE t.account_id=a.id AND t.deleted_at IS NULL AND t.status='a_traiter' AND t.txn_date >= '${RECON_SINCE}') AS a_traiter_count,
      (SELECT COUNT(*) FROM bank_transactions t WHERE t.account_id=a.id AND t.deleted_at IS NULL AND t.status IN ('a_traiter','facture_recue') AND t.txn_date >= '${RECON_SINCE}') AS todo_count,
      (SELECT COUNT(*) FROM bank_transactions t WHERE t.account_id=a.id AND t.deleted_at IS NULL AND t.review_flag=1 AND t.txn_date >= '${RECON_SINCE}') AS review_count,
      (SELECT MAX(t.txn_date) FROM bank_transactions t WHERE t.account_id=a.id AND t.deleted_at IS NULL) AS last_txn_date
    FROM bank_accounts a WHERE a.deleted_at IS NULL
    ORDER BY a.sort_order, a.name COLLATE NOCASE
  `).all()
  res.json(accounts)
})

const ACCOUNT_FIELDS = ['name', 'kind', 'currency', 'account_number', 'institution', 'sort_order', 'active', 'qb_account_id', 'bookmark_txn_id']

router.post('/accounts', (req, res) => {
  const name = String(req.body.name || '').trim()
  if (!name) return res.status(400).json({ error: 'name requis' })
  if (req.body.kind && !['bank', 'card'].includes(req.body.kind)) return res.status(400).json({ error: 'kind invalide (bank, card)' })
  const id = newRecordId()
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
    WHERE t.account_id=? AND t.deleted_at IS NULL AND t.txn_date >= ?
    ORDER BY t.txn_date DESC, t.created_at DESC
  `).all(account.id, RECON_SINCE)
  // Libellé du document apparié pour affichage direct dans le tableau, et
  // lien direct vers la transaction QB si le document a été publié.
  const achatLabel = db.prepare('SELECT vendor, total_cad AS total, quickbooks_id, type FROM achats_fournisseurs WHERE id=?')
  const receiptLabel = db.prepare('SELECT company AS vendor, total, quickbooks_id, quickbooks_type FROM sale_receipts WHERE id=?')
  const payoutQb = db.prepare('SELECT qb_deposit_id, stripe_id FROM stripe_payouts WHERE id=?')
  // Contrepartie d'un virement interne : le « document » de la ligne est
  // l'autre compte, pas une facture.
  const transferInfo = db.prepare(`
    SELECT t.id, t.account_id, a.name AS account_name
    FROM bank_transactions t JOIN bank_accounts a ON a.id = t.account_id
    WHERE t.id = ?
  `)
  // Le fournisseur derrière le libellé, pour les lignes SANS document : c'est
  // la seule information qui manquait pour lire le relevé sans l'interpréter
  // (« COMPTE DIVERS DT NETHRIS PAIE » ne dit pas « Nethris »). La résolution
  // est locale et mise en cache côté service ; `null` dès que deux profils
  // revendiquent le libellé avec la même force — on ne devine pas.
  for (const t of rows) {
    // Lien direct trouvé via le grand livre QB (linkAccountToQb) — prioritaire,
    // et seul disponible pour l'historique rapproché sans document ERP.
    t.qb_url = storedQbUrl(t)
    if (!t.matched_id && !t.transfer_txn_id) {
      const hit = resolveVendorFromBankLabel(t.label)
      if (hit) t.resolved_vendor = { profile_id: hit.profile.id, name: hit.profile.name, via: hit.via }
    }
    if (t.transfer_txn_id) {
      const o = transferInfo.get(t.transfer_txn_id)
      t.transfer_account_id = o?.account_id || null
      t.transfer_account_name = o?.account_name || null
      t.matched_label = o ? `Virement ${t.amount < 0 ? '→' : '←'} ${o.account_name}` : 'Virement'
      continue
    }
    if (!t.matched_id) continue
    let doc = null
    if (t.matched_type === 'achat') {
      doc = achatLabel.get(t.matched_id)
      if (doc?.quickbooks_id) t.qb_url = qbEntityUrl(doc.type === 'bill' ? 'bill' : 'expense', doc.quickbooks_id)
    } else if (t.matched_type === 'receipt') {
      doc = receiptLabel.get(t.matched_id)
      // Le chemin qui ouvre le document lui-même en panneau, depuis le tableau.
      t.matched_path = `/sale-receipts/${t.matched_id}`
      if (doc?.quickbooks_id) {
        const entity = doc.quickbooks_type === 'bill' ? 'bill'
          : doc.quickbooks_type === 'cc_credit' ? 'creditcardcredit'
          : doc.quickbooks_type === 'deposit' ? 'deposit'
          : 'expense'
        t.qb_url = qbEntityUrl(entity, doc.quickbooks_id)
      }
    } else if (t.matched_type === 'stripe_payout') {
      doc = { vendor: 'Payout Stripe' }
      const payout = payoutQb.get(t.matched_id)
      if (payout?.qb_deposit_id) t.qb_url = qbEntityUrl('deposit', payout.qb_deposit_id)
      if (payout?.stripe_id) t.matched_path = `/stripe-payouts/${payout.stripe_id}`
    }
    t.matched_label = doc?.vendor || null
  }
  // Une seule colonne « Fournisseur » à l'écran : le document apparié fait foi,
  // sinon le nom deviné du libellé. Champ à plat pour que le tri, la recherche
  // et les filtres du tableau fonctionnent comme sur n'importe quelle colonne.
  for (const t of rows) t.vendor_name = t.matched_label || t.resolved_vendor?.name || null
  // Ce qui attend une décision sur cette ligne (une requête pour tout le compte).
  // `publishing_count` isole celles qui écriraient dans QuickBooks : elles ne
  // partent jamais en lot, la page a besoin de le dire AVANT le clic.
  const pending = new Map(db.prepare(`
    SELECT bank_txn_id, kind, COUNT(*) n FROM bank_proposals
    WHERE status='proposee' AND account_id=? GROUP BY bank_txn_id, kind
  `).all(account.id).reduce((acc, r) => {
    const cur = acc.get(r.bank_txn_id) || { n: 0, publishing: 0 }
    cur.n += r.n
    if (PUBLISHES_TO_QB.has(r.kind)) cur.publishing += r.n
    acc.set(r.bank_txn_id, cur)
    return acc
  }, new Map()))
  for (const t of rows) {
    const p = pending.get(t.id)
    t.proposal_count = p?.n || 0
    t.publishing_count = p?.publishing || 0
  }
  // La suggestion affichée SUR la ligne (la plus sûre), avec ce qu'il faut pour
  // trancher sans ouvrir le panneau ; et celle que l'app a appliquée seule,
  // pour pouvoir l'annuler d'un clic.
  const pick = (status, extra = '') => {
    const m = new Map()
    for (const r of db.prepare(`
      SELECT id, bank_txn_id, kind, confidence, evidence, payload, auto_accepted FROM bank_proposals
      WHERE status=? AND account_id=? ${extra} ORDER BY confidence DESC
    `).all(status, account.id)) {
      if (m.has(r.bank_txn_id)) continue
      const d = decodeProposal(r)
      m.set(r.bank_txn_id, { id: d.id, kind: d.kind, confidence: d.confidence, evidence: d.evidence,
        payload: d.payload, publishes: PUBLISHES_TO_QB.has(d.kind) })
    }
    return m
  }
  const top = pick('proposee')
  const auto = pick('acceptee', 'AND auto_accepted=1')
  for (const t of rows) {
    t.suggestion = top.get(t.id) || null
    t.auto_suggestion = auto.get(t.id) || null
  }
  // La règle qui a préparé l'écriture : la ligne doit pouvoir dire d'où vient
  // ce qu'on lui propose (le champ était stocké et n'était affiché nulle part).
  const ruleNames = new Map(db.prepare('SELECT id, name FROM bank_rules').all().map((r) => [r.id, r.name]))
  for (const t of rows) t.rule_name = t.applied_rule_id ? (ruleNames.get(t.applied_rule_id) || null) : null
  // Sorties d'argent qui attendent encore leur pièce justificative. Le drapeau
  // est posé ici pour que la pastille « sans facture » de la barre d'outils
  // filtre comme n'importe quelle autre colonne du tableau.
  const ageThreshold = missingInvoiceAgeDays()
  const needs = new Map(db.prepare(`
    SELECT n.bank_txn_id, n.status,
           CAST(julianday('now') - julianday(n.txn_date) AS INTEGER) AS age_days,
           v.name AS vendor_name, s.label AS collector_label
    FROM invoice_needs n
    JOIN bank_transactions t ON t.id = n.bank_txn_id
    LEFT JOIN vendor_profiles v ON v.id = n.vendor_profile_id
    LEFT JOIN scraper_accounts s ON s.id = n.scraper_account_id
    WHERE n.status != 'trouvee' AND t.account_id = ? AND t.deleted_at IS NULL
  `).all(account.id).map(r => [r.bank_txn_id, r]))
  for (const t of rows) {
    const n = needs.get(t.id)
    t.invoice_need = n
      ? { status: n.status, age_days: n.age_days, vendor: n.vendor_name, collector: n.collector_label,
          overdue: n.age_days >= ageThreshold }
      : null
    t.missing_invoice = n ? 1 : 0
  }
  // Ce que Charles a lui-même réclamé : la pastille « demandées » et la marque
  // sur la ligne s'en servent. Aucun lien avec la détection automatique.
  const requested = new Set(db.prepare(`
    SELECT r.bank_txn_id FROM missing_invoice_requests r
    JOIN bank_transactions t ON t.id = r.bank_txn_id
    WHERE t.account_id = ?
  `).all(account.id).map((r) => r.bank_txn_id))
  for (const t of rows) t.invoice_requested = requested.has(t.id) ? 1 : 0
  res.json(rows)
})

// Import par collage. body: { text } (tab-séparé avec entêtes) ou { rows } déjà parsés.
router.post('/accounts/:id/import', (req, res) => {
  const account = getAccount(req.params.id)
  if (!account) return res.status(404).json({ error: 'Not found' })
  // Le collage était refusé sur un compte branché à Plaid (doublon garanti :
  // les deux sources ne partagent pas leur clé de dédup). Plaid n'écrit plus
  // dans la table depuis le 2026-09-12 (services/plaidSync.js) — le collage
  // redevient permis partout, comme la sync TRX_Orisha.
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

// Doublons hérités du fichier TRX_Orisha sur un compte désormais branché à
// Plaid : chaque mouvement y existe deux fois, avec deux clés de dédup
// étrangères l'une à l'autre. `dry_run` (défaut) liste les paires sans rien
// écrire ; sinon la ligne Plaid hérite du statut/lien QB de la ligne du
// fichier, qui est retirée.
router.post('/accounts/:id/merge-plaid-duplicates', (req, res) => {
  const account = getAccount(req.params.id)
  if (!account) return res.status(404).json({ error: 'Not found' })
  const apply = req.body?.dry_run === false
  res.json(mergeSheetDuplicates(account.id, { apply }))
})

// Comptes Banque / Carte de crédit côté QuickBooks (pour mapper qb_account_id).
router.get('/qb-accounts', async (req, res) => {
  try {
    res.json(await listQbBankAccounts())
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

// L'appariement naïf (montant exact, ±4 jours) a été débranché le 2026-09-15 :
// deux matchers qui se contredisaient sur les mêmes lignes, et c'est celui-ci
// qui perdait — 83 des 94 anomalies du 22 août 2026 étaient ses faux positifs.
// Tout passe désormais par la recherche approfondie (bankQbVerify.js).

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
  // `plaid_duplicates` : mouvements présents en double (ligne Plaid + ligne
  // TRX_Orisha). 0 = rien à proposer côté UI.
  res.json({ ...summarizeAccount(account.id), plaid_duplicates: countSheetDuplicates(account.id) })
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

// Vérification approfondie d'un compte contre QuickBooks — TOUS les comptes
// mappés, plus seulement ceux branchés à Plaid. `deep: true` (ou sinceDays
// omis) couvre tout l'historique et efface les liens devenus introuvables.
router.post('/accounts/:id/qb-audit', async (req, res) => {
  const account = getAccount(req.params.id)
  if (!account) return res.status(404).json({ error: 'Not found' })
  const sinceDays = req.body?.sinceDays != null ? Number(req.body.sinceDays) : null
  try {
    res.json(await verifyAccount(account.id, {
      from: sinceDays ? shiftDate(new Date().toISOString().slice(0, 10), -sinceDays) : null,
      deep: !sinceDays,
      trigger: 'manuel',
    }))
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// Robot « Rapprocher » QuickBooks, tranche 1 : ouvre l'écran du compte avec la
// session du pont de session, capture et lit — ne modifie rien dans QuickBooks.
router.post('/accounts/:id/qb-reconcile/probe', requireAdmin, async (req, res) => {
  const account = getAccount(req.params.id)
  if (!account) return res.status(404).json({ error: 'Not found' })
  const out = await openReconcile(account.id)
  res.json({
    ...out,
    captureUrl: out.capture ? `/erp/api/bank/qb-reconcile/captures/${encodeURIComponent(out.capture)}` : null,
  })
})

// Robot « Rapprocher », tranche 2 : coche les lignes vertes dans QuickBooks, lit
// la Différence, enregistre pour plus tard — ne termine JAMAIS (c'est Charles).
// Le passage prend une à deux minutes : POST le lance en arrière-plan, la page
// relit GET jusqu'à ce que `running` retombe.
const captureUrl = (name) => (name ? `/erp/api/bank/qb-reconcile/captures/${encodeURIComponent(name)}` : null)

function lastReconcileRun(accountId) {
  const r = db.prepare('SELECT * FROM bank_qb_reconcile_runs WHERE account_id=? ORDER BY created_at DESC LIMIT 1').get(accountId)
  if (!r) return null
  const json = (v) => { try { return JSON.parse(v || '[]') } catch { return [] } }
  return {
    id: r.id, ok: !!r.ok, at: r.created_at, statement_date: r.statement_date, ending_balance: r.ending_balance,
    difference: r.difference, checked: r.checked, already_checked: r.already_checked,
    saved: !!r.saved, resumed: !!r.resumed, needs_session: !!r.needs_session, error: r.error,
    unmatched_boreal: json(r.unmatched_boreal), unmatched_qb: json(r.unmatched_qb),
    screenshot_url: captureUrl(r.screenshot),
    view: (() => { try { return JSON.parse(r.result || '{}').view || null } catch { return null } })(),
  }
}

let reconcileRunningFor = null
// « Fermer le mois » : rapprochements à 0 $ qui attendent « Terminer » dans QuickBooks.
router.get('/month-close', (req, res) => res.json(monthCloseStatus()))

router.get('/accounts/:id/qb-reconcile', (req, res) => {
  const account = getAccount(req.params.id)
  if (!account) return res.status(404).json({ error: 'Not found' })
  res.json({ running: isRobotRunning() && reconcileRunningFor === account.id, last: lastReconcileRun(account.id) })
})

router.post('/accounts/:id/qb-reconcile', requireAdmin, (req, res) => {
  const account = getAccount(req.params.id)
  if (!account) return res.status(404).json({ error: 'Not found' })
  if (!isSystemAutomationActive(RECONCILE_AUTOMATION_ID)) return res.status(409).json({ error: 'Robot désactivé (Automations)' })
  if (isRobotRunning()) return res.status(409).json({ error: 'Un passage du robot est déjà en cours' })
  reconcileRunningFor = account.id
  const userId = req.user?.id || null
  reconcileAccount(account.id).then((out) => {
    db.prepare(`
      INSERT INTO bank_qb_reconcile_runs (id, account_id, ok, statement_date, ending_balance, difference, checked,
        already_checked, saved, resumed, unmatched_boreal, unmatched_qb, screenshot, error, needs_session, result, run_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(newRecordId(), account.id, out.ok ? 1 : 0, out.statement_date || null, out.ending_balance ?? null,
      out.difference ?? null, out.checked || 0, out.already_checked || 0, out.saved ? 1 : 0, out.resumed ? 1 : 0,
      JSON.stringify(out.unmatched_boreal || []), JSON.stringify(out.unmatched_qb || []), out.screenshot || null,
      out.error || out.hint || null, out.needsSession ? 1 : 0, JSON.stringify(out), userId)
    const diffTxt = out.difference == null ? '—' : `${out.difference.toFixed(2)} $`
    logSystemRun(RECONCILE_AUTOMATION_ID, {
      status: out.ok ? 'success' : 'error',
      result: out.ok
        ? `${account.name} au ${out.statement_date} : différence ${diffTxt} · ${out.checked} cochée(s) · ${out.already_checked} déjà cochée(s) · ` +
          `${out.unmatched_boreal.length} verte(s) introuvable(s) · ${out.unmatched_qb.length} écriture(s) QB sans ligne verte · ` +
          (out.saved ? 'enregistré pour plus tard' : `NON enregistré (${out.save_note})`)
        : null,
      error: out.ok ? null : (out.error || out.hint || out.screen || 'échec'),
      duration_ms: out.duration_ms,
      triggerData: { account_id: account.id, account: account.name, trace: out.trace },
    })
  }).catch((e) => {
    logSystemRun(RECONCILE_AUTOMATION_ID, { status: 'error', error: e.message, triggerData: { account_id: account.id } })
  }).finally(() => { reconcileRunningFor = null })
  res.status(202).json({ running: true })
})

router.get('/qb-reconcile/captures/:name', requireAdmin, (req, res) => {
  const file = joinPath(QB_RECONCILE_CAPTURES, basename(req.params.name))
  if (!fileExists(file)) return res.status(404).json({ error: 'Not found' })
  res.sendFile(file)
})

// Réparation ponctuelle des montants de l'import historique (voir
// services/bankImportRepair.js). `apply` absent = simulation : on renvoie le
// plan sans rien écrire.
router.post('/accounts/:id/repair-import', requireAdmin, async (req, res) => {
  const account = getAccount(req.params.id)
  if (!account) return res.status(404).json({ error: 'Not found' })
  const iso = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : undefined)
  try {
    const plan = await planRepair(account.id, { from: iso(req.body?.from), to: iso(req.body?.to) })
    if (!req.body?.apply) return res.json({ ...plan, applied: false })
    const applied = applyRepair(plan)
    // Les lignes réparées par le libellé n'ont pas encore leur écriture QB :
    // la recherche approfondie sait maintenant les retrouver, le montant étant
    // enfin celui du grand livre.
    let qb = null
    let qbError = null
    if (account.qb_account_id) {
      try { qb = await verifyAccount(account.id, { deep: true, trigger: 'reparation' }) } catch (e) { qbError = e.message }
    }
    res.json({ ...plan, applied: true, ...applied, qb, qbError, summary: summarizeAccount(account.id) })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// « Mettre à jour » — LE seul bouton de la page depuis le 2026-09-15. Il y en
// avait quatre (« Rapprocher », « Recalculer QuickBooks », « Chercher dans tout
// QuickBooks », « Relire TRX_Orisha ») et personne ne savait lequel faisait
// quoi. Une seule action, trois temps : apparier aux documents de l'ERP,
// vérifier dans QuickBooks, recalculer l'écart. Le tout raconté en une phrase.
router.post('/accounts/:id/update-all', async (req, res) => {
  const account = getAccount(req.params.id)
  if (!account) return res.status(404).json({ error: 'Not found' })

  const auto = autoMatchAccount(account.id)
  let qb = null
  let qbError = null
  if (account.qb_account_id) {
    try { qb = await verifyAccount(account.id, { trigger: 'manuel' }) } catch (e) { qbError = e.message }
  }

  const said = []
  if (auto.matched) said.push(`${auto.matched} document${auto.matched > 1 ? 's' : ''} apparié${auto.matched > 1 ? 's' : ''}`)
  if (qb?.linked) said.push(`${qb.linked} écriture${qb.linked > 1 ? 's' : ''} QuickBooks retrouvée${qb.linked > 1 ? 's' : ''}`)
  if (qb?.proposed) said.push(`${qb.proposed} à confirmer`)
  if (qb?.reconciled) said.push(`${qb.reconciled} rapprochée${qb.reconciled > 1 ? 's' : ''}`)
  if (qbError) said.push(`QuickBooks indisponible (${qbError})`)
  if (!said.length) said.push('rien de neuf')

  res.json({ ...auto, qb, qbError, message: said.join(' · '), summary: summarizeAccount(account.id) })
})

function getTxn(id) {
  return db.prepare('SELECT * FROM bank_transactions WHERE id=? AND deleted_at IS NULL').get(id)
}

// Le geste qu'attend chaque ligne, pour tout un compte d'un coup (maquette B3,
// 2026-09-19) : la vue QuickBooks pose sur la ligne le bouton juste — « Lier le
// virement », « Apparier », « Publier » — au lieu de laisser chercher.
// Un seul aller-retour : la page en fait un par compte, pas un par ligne.
// Le plafond était de 120 lignes : un compte qui en a davantage (la BNC CAD en
// a 133) laissait la colonne du geste vide sans le dire. 400 couvre tous les
// comptes ; au-delà, mieux vaut découper que deviner.
router.get('/accounts/:id/next-actions', (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM bank_transactions
    WHERE account_id = ? AND deleted_at IS NULL
      AND transfer_txn_id IS NULL
      AND status NOT IN ('rapproche', 'ignore')
    ORDER BY txn_date DESC
    LIMIT 400
  `).all(req.params.id)

  const out = {}
  for (const t of rows) {
    // Déjà dans QuickBooks (écriture retrouvée) : il n'y a plus rien à publier
    // ni à apparier — proposer « Publier » sur une ligne jaune faisait croire
    // qu'elle n'était pas comptabilisée, et risquait un doublon.
    if (t.qb_txn_id) continue
    // Déjà appariée : le seul geste qui reste est de faire partir l'écriture
    // dans QuickBooks, quand elle n'est jamais partie.
    if (t.matched_id) {
      const state = matchedDocState(t)
      if (state && !state.booked && !state.blocked) {
        out[t.id] = { kind: 'comptabiliser', label: state.label, count: 1 }
      }
      continue
    }
    // Un virement interne se reconnaît sans ambiguïté : même montant, sens
    // opposé, à un jour ou deux près. Il passe devant la facture, sinon la
    // moitié d'un mouvement interne se retrouve comptabilisée en dépense.
    const transfers = findTransferCandidates(t)
    const tr = transfers[0]
    if (tr && !tr.fx && tr.confidence >= 0.9) {
      out[t.id] = { kind: 'virement', label: tr.account_name, count: transfers.length }
      continue
    }
    const docs = findCandidates(t)
    const doc = docs[0]
    if (doc && doc.confidence >= 0.6) {
      out[t.id] = { kind: 'apparier', label: doc.label, count: docs.length }
      continue
    }
    const rule = ruleForTxn(t)
    if (rule) {
      out[t.id] = { kind: 'publier', label: rule.name, count: 1 }
      continue
    }
    if (tr) { out[t.id] = { kind: 'virement', label: tr.account_name, count: transfers.length }; continue }
    if (doc) { out[t.id] = { kind: 'apparier', label: doc.label, count: docs.length }; continue }
    out[t.id] = { kind: 'rien', label: null, count: 0 }
  }
  res.json(out)
})

// Candidats de matching (pour le drawer de suggestions).
router.get('/transactions/:id/suggestions', (req, res) => {
  const txn = getTxn(req.params.id)
  if (!txn) return res.status(404).json({ error: 'Not found' })
  res.json(findCandidates(txn).slice(0, 8))
})

// Appariement manuel. body: { matched_type, matched_id } — ou null pour délier.
// Le lien posé, le document apparié est publié dans QuickBooks s'il ne l'est
// pas déjà : apparier ici, c'est comptabiliser là-bas (demande de Charles,
// 2026-09-19). `push_qb: false` pour ne poser que le lien.
router.post('/transactions/:id/match', async (req, res) => {
  const txn = getTxn(req.params.id)
  if (!txn) return res.status(404).json({ error: 'Not found' })
  const { matched_type: type, matched_id: id } = req.body
  if (txn.transfer_txn_id) {
    return res.status(409).json({ error: 'Ligne liée à un virement — défaire le virement d\'abord' })
  }
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
  // Une ligne déjà rapprochée (verte) à laquelle on ne fait qu'ajouter la pièce
  // qui lui manquait garde son rapprochement ; seule une ligne qui CHANGE de
  // document repart à zéro.
  const keep = !txn.matched_id && txn.reconciled_at ? txn : null
  const status = deriveStatus({ ...txn, matched_type: type, matched_id: String(id), reconciled_at: keep?.reconciled_at || null })
  db.prepare(`
    UPDATE bank_transactions
    SET matched_type=?, matched_id=?, match_method='manuel', match_confidence=1,
        reconciled_at=?, reconciled_by=?, status=?, updated_at=${NOW}
    WHERE id=?
  `).run(type, String(id), keep?.reconciled_at || null, keep?.reconciled_by || null, status, txn.id)
  // La date comptable du document devient celle du débit (sa date imprimée est
  // conservée à part) — avant toute publication dans QuickBooks.
  if (type === 'receipt') {
    try {
      const { alignReceiptDate } = await import('../services/receiptBankDate.js')
      alignReceiptDate(String(id))
    } catch (e) { console.warn('alignReceiptDate:', e.message) }
  }
  mirrorSoon('document')

  let qb = { quickbooks_id: null, already: false, error: null, field: null }
  if (req.body?.push_qb !== false) qb = await publishMatchedDoc(getTxn(txn.id))
  res.json({ ...getTxn(txn.id), quickbooks_id: qb.quickbooks_id, qbAlready: qb.already, qbError: qb.error, qbField: qb.field })
})

// Rattrapage : publier le document d'une ligne déjà appariée mais dont
// l'écriture n'est jamais partie dans QuickBooks.
router.post('/transactions/:id/publish-matched', async (req, res) => {
  const txn = getTxn(req.params.id)
  if (!txn) return res.status(404).json({ error: 'Not found' })
  const state = matchedDocState(txn)
  if (!state) return res.status(400).json({ error: 'Cette ligne n\'est appariée à aucun document' })
  if (state.booked) return res.json({ ...txn, quickbooks_id: null, qbAlready: true, qbError: null })
  const qb = await publishMatchedDoc(txn)
  if (qb.error) return res.status(502).json({ error: qb.error, field: qb.field })
  res.json({ ...getTxn(txn.id), quickbooks_id: qb.quickbooks_id, qbAlready: false, qbError: null })
})

// Rapprochement (vert) — en lot. body: { ids: [...] }. `unreconcile: true` pour annuler.
router.post('/transactions/reconcile', (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : []
  if (!ids.length) return res.status(400).json({ error: 'ids requis' })
  const un = req.body.unreconcile === true
  const stmt = un
    ? db.prepare(`UPDATE bank_transactions SET reconciled_at=NULL, reconciled_by=NULL, reconcile_method='annule', status='a_traiter', updated_at=${NOW} WHERE id=? AND deleted_at IS NULL`)
    : db.prepare(`UPDATE bank_transactions SET reconciled_at=${NOW}, reconciled_by=?, reconcile_method='manuel', status='rapproche', updated_at=${NOW} WHERE id=? AND deleted_at IS NULL`)
  let changed = 0
  const tx = db.transaction(() => {
    for (const id of ids) {
      changed += un ? stmt.run(id).changes : stmt.run(req.user.id, id).changes
    }
  })
  tx()
  // Les statuts dé-rapprochés retombent sur la valeur dérivée au prochain GET.
  mirrorSoon('rapprochement')
  res.json({ changed })
})

// ── Propositions ────────────────────────────────────────────────────────────
// « Elle prépare, vous confirmez » : les moteurs déposent ici ce qu'ils ont
// trouvé, l'humain tranche. Un refus est définitif (voir bankProposals/model).

router.get('/proposals', (req, res) => {
  const { status = 'proposee', kind, account_id: accountId, limit } = req.query
  const where = ['p.status = ?']
  const args = [status]
  if (kind) { where.push('p.kind = ?'); args.push(kind) }
  if (accountId) { where.push('p.account_id = ?'); args.push(accountId) }
  const rows = db.prepare(`
    SELECT p.*, t.txn_date, t.amount AS txn_amount,
           COALESCE(NULLIF(t.details,''), t.description) AS txn_label,
           a.name AS account_name, a.currency
    FROM bank_proposals p
    JOIN bank_transactions t ON t.id = p.bank_txn_id
    LEFT JOIN bank_accounts a ON a.id = p.account_id
    WHERE ${where.join(' AND ')}
    ORDER BY t.txn_date DESC
    LIMIT ?
  `).all(...args, Math.min(Number(limit) || 200, 500))
  res.json(rows.map(decodeProposal))
})

router.get('/proposals/summary', (req, res) => {
  res.json(proposalSummary(req.query.account_id || null))
})

router.get('/transactions/:id/proposals', (req, res) => {
  res.json(proposalsForTxn(req.params.id))
})

router.post('/proposals/:id/accept', async (req, res) => {
  try {
    res.json(await acceptProposal(req.params.id, req.user?.id))
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
})

router.post('/proposals/:id/undo', async (req, res) => {
  try {
    res.json(await undoProposal(req.params.id, req.user?.id))
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
})

router.post('/proposals/:id/refuse', (req, res) => {
  try {
    res.json(refuseProposal(req.params.id, req.user?.id, req.body?.note || null))
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
})

// En lot : chaque proposition est indépendante — un échec QuickBooks sur l'une
// ne doit pas annuler les autres.
// Ce qui PUBLIE dans QuickBooks (dépense, répartition AGA) ne part jamais en
// lot : ces propositions ressortent dans `skipped` et attendent leur clic.
router.post('/proposals/accept', async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : []
  const accepted = []
  const failed = []
  const skipped = []
  for (const id of ids) {
    const p = getProposal(id)
    if (p && !isBatchAcceptable(p.kind)) { skipped.push({ id, kind: p.kind }); continue }
    try { accepted.push((await acceptProposal(id, req.user?.id)).id) }
    catch (e) { failed.push({ id, error: e.message }) }
  }
  res.json({ accepted: accepted.length, skipped, failed })
})

router.post('/proposals/refuse', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : []
  let refused = 0
  const failed = []
  for (const id of ids) {
    try { refuseProposal(id, req.user?.id, req.body?.note || null); refused++ }
    catch (e) { failed.push({ id, error: e.message }) }
  }
  res.json({ refused, failed })
})

// « Ce libellé, c'est ce fournisseur » : apprend un motif de relevé sur la
// fiche du fournisseur, depuis la ligne bancaire. Sans ça il fallait ouvrir
// /fournisseurs, retrouver le profil et y coller le motif à la main.
// Le cache de résolution est vidé tout de suite — sinon le motif met jusqu'à
// 30 secondes à prendre effet et l'utilisateur croit que ça n'a pas marché.
router.post('/transactions/:id/vendor-pattern', (req, res) => {
  const txn = getTxn(req.params.id)
  if (!txn) return res.status(404).json({ error: 'Not found' })
  const profileId = String(req.body?.profile_id || '').trim()
  const pattern = String(req.body?.pattern || '').trim()
  if (!profileId || pattern.length < 3) {
    return res.status(400).json({ error: 'profile_id et un motif d\'au moins 3 caractères sont requis' })
  }
  const profile = db.prepare('SELECT id, name, bank_label_patterns FROM vendor_profiles WHERE id=?').get(profileId)
  if (!profile) return res.status(404).json({ error: 'Fournisseur introuvable' })
  let patterns = []
  try { patterns = JSON.parse(profile.bank_label_patterns || '[]') } catch { patterns = [] }
  if (!patterns.some((p) => String(p).toLowerCase() === pattern.toLowerCase())) patterns.push(pattern)
  db.prepare(`UPDATE vendor_profiles SET bank_label_patterns=?, updated_at=${NOW} WHERE id=?`)
    .run(JSON.stringify(patterns), profile.id)
  invalidateBankLabelCache()
  res.json({ ok: true, vendor: profile.name, patterns })
})

// L'écriture QuickBooks de la ligne, telle que QuickBooks l'affiche — pour
// confirmer sans aller-retour dans QBO. Lecture seule, et le lien direct vers
// QBO est toujours renvoyé même quand le détail ne se lit pas.
router.get('/transactions/:id/qb-entry', async (req, res) => {
  const txn = getTxn(req.params.id)
  if (!txn) return res.status(404).json({ error: 'Not found' })
  if (!txn.qb_txn_id || !txn.qb_txn_type) {
    return res.status(404).json({ error: 'Aucune écriture QuickBooks liée à cette ligne' })
  }
  const { fetchQbEntry } = await import('../services/qbEntry.js')
  res.json({
    ...(await fetchQbEntry(txn.qb_txn_type, txn.qb_txn_id)),
    match_method: txn.qb_match_method || null,
    match_delta: txn.qb_match_delta ?? null,
    match_account: txn.qb_match_account || null,
    match_rate: txn.qb_match_rate || null,
    bank_amount: txn.amount,
    bank_date: txn.txn_date,
  })
})

// ── Le dossier d'une ligne ───────────────────────────────────────────────────
//
// Ce qu'il y a à comptabiliser pour cette ligne, et QUI le porte. Une ligne de
// relevé n'a jamais une seule nature : c'est une facture à publier, un
// versement de dette dont la ventilation vit dans la cédule, une paie, un
// paiement émis. Chacune avait son écran ; le panneau latéral du rapprochement
// les affiche maintenant sur place, d'où ce point d'entrée unique.
//
// Ne renvoie que ce qui EXISTE déjà (document apparié, versement rattaché) :
// rien n'est deviné ici — deviner, c'est le travail des propositions.
router.get('/transactions/:id/dossier', (req, res) => {
  const txn = getTxn(req.params.id)
  if (!txn) return res.status(404).json({ error: 'Not found' })

  const out = { document: null, debt: null, paie: null, payment: null, invoices: [], receipts: [] }

  // Le document apparié, avec la route qui l'ouvre en panneau empilé quand il
  // y en a une (reçus, payouts) ; les achats fournisseurs n'ont pas de route
  // de fiche, le client ouvre leur formulaire par `type`.
  if (txn.matched_type && txn.matched_id) {
    const id = String(txn.matched_id)
    if (txn.matched_type === 'achat') {
      const a = db.prepare(`SELECT vendor, total_cad, type, quickbooks_id, status FROM achats_fournisseurs WHERE id=?`).get(id)
      if (a) {
        out.document = {
          type: 'achat', id, label: a.vendor || 'Achat', total: a.total_cad,
          booked: !!a.quickbooks_id,
          hint: a.type === 'bill' ? 'Facture fournisseur' : 'Dépense',
        }
      }
    } else if (txn.matched_type === 'receipt') {
      const r = db.prepare(`SELECT company, total, quickbooks_id FROM sale_receipts WHERE id=?`).get(id)
      if (r) {
        out.document = {
          type: 'receipt', id, label: r.company || 'Document', total: r.total,
          booked: !!r.quickbooks_id, path: `/sale-receipts/${id}`, hint: 'Document extrait',
        }
      }
    } else if (txn.matched_type === 'stripe_payout') {
      // La fiche d'un payout s'adresse par son id Stripe (po_…), pas par l'id
      // ERP que porte `matched_id` — sans quoi le lien ne s'ouvre pas.
      const p = db.prepare(`SELECT stripe_id, amount, qb_deposit_id FROM stripe_payouts WHERE id=?`).get(id)
      if (p) {
        out.document = {
          type: 'stripe_payout', id, label: 'Payout Stripe', total: p.amount,
          booked: !!p.qb_deposit_id, path: `/stripe-payouts/${p.stripe_id}`, hint: 'Versement Stripe',
        }
      }
    }
  }

  // Le versement de dette rattaché à cette ligne : la ventilation capital /
  // intérêts / frais se comptabilise depuis le panneau, sans passer par
  // /dettes-lt.
  const pay = db.prepare(`
    SELECT p.*, d.id AS debt_id, d.label AS debt_label, d.loan_number, d.currency,
           d.qb_debt_acctnum, d.qb_interest_acctnum, d.qb_bank_acctnum,
           d.annual_fee_acctnum, d.annual_fee_label
    FROM lt_debt_payments p JOIN lt_debts d ON d.id = p.debt_id
    WHERE p.bank_txn_id = ? AND p.deleted_at IS NULL AND d.deleted_at IS NULL
  `).get(txn.id)
  if (pay) {
    out.debt = {
      debt: {
        id: pay.debt_id, label: pay.debt_label, loan_number: pay.loan_number,
        currency: pay.currency || 'CAD',
        qb_debt_acctnum: pay.qb_debt_acctnum, qb_interest_acctnum: pay.qb_interest_acctnum,
        qb_bank_acctnum: pay.qb_bank_acctnum,
        annual_fee_acctnum: pay.annual_fee_acctnum, annual_fee_label: pay.annual_fee_label,
      },
      payment: {
        id: pay.id, payment_date: pay.payment_date,
        // La date qui sera comptabilisée : celle du débit au compte.
        bank_date: txn.txn_date,
        principal: pay.principal,
        interest: pay.interest, balance_after: pay.balance_after,
        bank_extra_amount: pay.bank_extra_amount, pushed_at: pay.pushed_at,
        qb_txn_id: pay.qb_txn_id, qb_txn_type: pay.qb_txn_type,
      },
      qb_url: pay.qb_txn_id
        ? qbEntityUrl(pay.qb_txn_type === 'purchase' ? 'expense' : 'journal', pay.qb_txn_id)
        : null,
    }
  }

  // La paie dont c'est le débit. Rattacher n'est pas publier : la dépense de
  // paie reste un second geste, que le panneau ouvre au lieu d'y renvoyer.
  const paie = db.prepare(`
    SELECT id, number, period_start, period_end, salary_purchase_id
    FROM paies WHERE bank_txn_id = ?
  `).get(txn.id)
  if (paie) out.paie = { ...paie, booked: !!paie.salary_purchase_id }

  // Le prélèvement de l'assurance collective (AGA) : reconnu par le libellé de
  // l'automation, il se comptabilise depuis la ligne tant qu'aucune écriture
  // QuickBooks ne le porte.
  if (txn.amount < 0 && !txn.qb_txn_id && !txn.matched_id && !txn.transfer_txn_id) {
    const cfg = getPaieRepartitionConfig()
    if (labelMatchesPattern(`${txn.details || ''} ${txn.description || ''}`, cfg.aga_bank_label_pattern)) {
      out.aga = { id: txn.id, amount: Math.round(Math.abs(txn.amount) * 100) / 100, txn_date: txn.txn_date }
    }
  }

  // ENCAISSEMENT CLIENT. Un virement Interac d'un client (« 600-4386 » pour La
  // ferme Décembre) n'a aucun document dans l'ERP : il faut aller marquer la
  // facture payée ailleurs. Les factures ouvertes DU MÊME MONTANT sont donc
  // remontées ici, avec de quoi enregistrer le paiement sur place.
  // Le montant ne désigne pas la facture à lui seul : plusieurs sont ouvertes
  // au même total. Le nom du payeur écrit au relevé et la date tranchent, et
  // chaque candidate arrive avec ses raisons.
  if (txn.amount > 0 && !txn.matched_id && !txn.transfer_txn_id) {
    const { candidates, ambiguous } = findInvoiceCandidates(txn, getAccount(txn.account_id))
    out.invoices = candidates
    out.invoices_ambiguous = ambiguous
  }

  // LA PIÈCE DÉJÀ LUE. Une sortie d'argent a presque toujours sa facture dans
  // l'extracteur ou dans les achats, mais ni le montant ni la date ne suffisent
  // à la désigner. Une entrée peut aussi avoir la sienne : remboursement
  // d'impôt, note de crédit — une pièce à total négatif. Le statut de la ligne
  // n'entre pas dans la condition : une ligne déjà rapprochée mais sans
  // document mérite aussi sa pièce.
  if (txn.amount && !txn.matched_id && !txn.transfer_txn_id) {
    const { candidates, ambiguous } = findDocCandidates(txn, getAccount(txn.account_id), { excludeTxnId: txn.id })
    out.receipts = candidates
    out.receipts_ambiguous = ambiguous
  }

  // Le paiement émis passé au compte : rien à comptabiliser, mais il nomme la
  // ligne mieux que le relevé.
  const tp = db.prepare(`
    SELECT id, label, payment_date, amount, direction, method, achat_id
    FROM treasury_payments WHERE bank_txn_id = ? AND deleted_at IS NULL
  `).get(txn.id)
  if (tp) out.payment = tp

  res.json(out)
})

// La détection n'a pas trouvé : l'humain cherche lui-même parmi les factures
// ouvertes, par nom d'entreprise ou numéro. Les mêmes raisons sont calculées,
// pour qu'un choix manuel se juge avec les mêmes yeux qu'une proposition.
router.get('/transactions/:id/invoice-search', (req, res) => {
  const txn = getTxn(req.params.id)
  if (!txn) return res.status(404).json({ error: 'Not found' })
  const q = String(req.query.q || '').trim()
  if (q.length < 2) return res.json({ candidates: [] })
  res.json(findInvoiceCandidates(txn, getAccount(txn.account_id), { q, limit: 8 }))
})

// Même geste pour une sortie d'argent : l'humain nomme lui-même la pièce, par
// fournisseur ou par numéro, et la voit notée comme si la détection l'avait
// proposée.
router.get('/transactions/:id/receipt-search', (req, res) => {
  const txn = getTxn(req.params.id)
  if (!txn) return res.status(404).json({ error: 'Not found' })
  const q = String(req.query.q || '').trim()
  if (q.length < 2) return res.json({ candidates: [] })
  res.json(findDocCandidates(txn, getAccount(txn.account_id), { q, limit: 8, excludeTxnId: txn.id }))
})

// « Ce n'est pas ça » : le lien proposé est refusé. On efface le lien, PAS
// l'écriture QuickBooks — elle existe, elle appartient juste à une autre
// ligne. La recherche approfondie pourra en proposer une autre.
router.delete('/transactions/:id/qb-link', (req, res) => {
  const txn = getTxn(req.params.id)
  if (!txn) return res.status(404).json({ error: 'Not found' })
  db.prepare(`
    UPDATE bank_transactions
    SET qb_txn_type=NULL, qb_txn_id=NULL, qb_match_method=NULL, qb_match_delta=NULL,
        qb_match_account=NULL, qb_match_rate=NULL, reconciled_at=NULL, reconciled_by=NULL,
        updated_at=${NOW}
    WHERE id=?
  `).run(txn.id)
  refreshStatuses(txn.account_id)
  // Le lien disparaît même quand le statut ne bouge pas (la ligne reste
  // comptabilisée par son document) : la page doit le voir partir.
  touchBankTxns([txn.id])
  mirrorSoon('lien-qb')
  res.json(getTxn(txn.id))
})

// ── Factures manquantes réclamées à la main ────────────────────────────────
//
// La liste ne se remplit QUE par le bouton « Facture manquante » de la barre de
// sélection du relevé (décision de Charles, 2026-09-29) : la détection
// automatique reste la pastille « sans facture », qui ne la touche pas.
router.get('/invoice-requests', (req, res) => {
  res.json({ requests: listInvoiceRequests(), message: buildInvoiceRequestMessage() })
})

router.post('/invoice-requests', (req, res) => {
  const ids = Array.isArray(req.body?.txn_ids) ? req.body.txn_ids : []
  if (!ids.length) return res.status(400).json({ error: 'txn_ids requis' })
  const requests = addInvoiceRequests(ids, req.user?.name || req.user?.email || null)
  touchBankTxns(ids)
  res.json({ requests, message: buildInvoiceRequestMessage(requests) })
})

// Sortir une facture de la LISTE (elle n'est plus réclamée du tout).
router.delete('/invoice-requests/:txnId', (req, res) => {
  const requests = removeInvoiceRequest(req.params.txnId)
  touchBankTxns([req.params.txnId])
  res.json({ requests, message: buildInvoiceRequestMessage(requests) })
})

// Sortir une facture de l'ENVOI sans la sortir de la liste — et l'y remettre.
router.patch('/invoice-requests/:txnId', (req, res) => {
  const requests = setInvoiceRequestInSend(req.params.txnId, req.body?.in_send !== false)
  res.json({ requests, message: buildInvoiceRequestMessage(requests) })
})

router.post('/invoice-requests/send', async (req, res) => {
  try {
    const out = await sendInvoiceRequests({ user: req.user?.name || req.user?.email || null })
    if (!out.sent) return res.status(400).json({ error: out.reason === 'vide' ? 'Aucune facture dans l\'envoi' : 'Envoi désactivé' })
    res.json({ ...out, message: buildInvoiceRequestMessage(out.requests) })
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

// « X » : la ligne part à la relecture de Michel. La marque vit dans Boréal et
// se recopie dans la colonne X du classeur, à la place où elle a toujours été.
router.post('/transactions/:id/review', (req, res) => {
  const txn = getTxn(req.params.id)
  if (!txn) return res.status(404).json({ error: 'Not found' })
  const on = req.body?.on !== false
  db.prepare(`
    UPDATE bank_transactions
    SET review_flag=?, review_flag_at=${NOW}, updated_at=${NOW}
    WHERE id=?
  `).run(on ? 1 : 0, txn.id)
  touchBankTxns([txn.id])
  mirrorSoon('relecture')
  res.json(getTxn(txn.id))
})

// Édition libre : commentaire, statut ignore, date/montant (correction de collage).
const TXN_FIELDS = ['comment', 'txn_date', 'description', 'details', 'reference', 'amount', 'balance', 'interest_cad']

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
  mirrorSoon('modification')
  res.json(getTxn(txn.id))
})

router.delete('/transactions/:id', (req, res) => {
  const txn = getTxn(req.params.id)
  if (!txn) return res.status(404).json({ error: 'Not found' })
  db.prepare(`UPDATE bank_transactions SET deleted_at=${NOW} WHERE id=?`).run(txn.id)
  mirrorSoon('suppression')
  // La contrepartie d'un virement ne doit pas rester à pointer une ligne
  // supprimée : elle redevient une ligne ordinaire, à retraiter.
  if (txn.transfer_txn_id) {
    db.prepare(`
      UPDATE bank_transactions
      SET transfer_txn_id=NULL, transfer_amount=NULL, status='a_traiter', updated_at=${NOW}
      WHERE id=? AND qb_txn_id IS NULL
    `).run(txn.transfer_txn_id)
  }
  res.json({ ok: true })
})

// ── Ajouter / Transfert : les deux gestes de « Opérations bancaires » ────────

// Ce que l'ERP propose de mettre dans l'écriture pour cette ligne, et pourquoi.
router.get('/transactions/:id/add-defaults', (req, res) => {
  const txn = getTxn(req.params.id)
  if (!txn) return res.status(404).json({ error: 'Not found' })
  res.json(suggestAddDefaults(txn, getAccount(txn.account_id)))
})

// Comptabilise une ligne sans document : crée l'achat puis le publie.
// body: { vendor, expense_account_id, tax_code_id?, tax_cad?, memo?, payment_account_id?,
//         qb_type?, doc_number?, payment_method?, due_date?, push_qb=true }
router.post('/transactions/:id/add-expense', async (req, res) => {
  const txn = getTxn(req.params.id)
  if (!txn) return res.status(404).json({ error: 'Not found' })
  const account = getAccount(txn.account_id)

  let achatId
  try {
    ({ achatId } = addExpenseFromTxn(txn, account, req.body || {}, req.user.id))
  } catch (e) {
    if (e instanceof BankActionError) return res.status(e.status).json({ error: e.message, field: e.field })
    throw e
  }

  // L'achat existe et la ligne est liée : un échec QuickBooks ne les annule
  // pas, il se raconte. Le push reste rejouable depuis la fiche de l'achat.
  let quickbooks_id = null, qbError = null, qbField = null
  if (req.body?.push_qb !== false) {
    try {
      const { pushAchatToQB } = await import('../services/quickbooks.js')
      quickbooks_id = await pushAchatToQB(achatId)
      const { learnFromPush } = await import('../services/vendorProfiles.js')
      try {
        learnFromPush({
          company: String(req.body.vendor).trim(),
          txnCurrency: account.currency || 'CAD',
          // Le type publié, pas « purchase » en dur : si ce fournisseur se
          // traite en facture fournisseur, le profil doit l'apprendre.
          type: ['purchase', 'bill', 'cc_credit'].includes(req.body.qb_type) ? req.body.qb_type : 'purchase',
          expenseAccountId: req.body.expense_account_id,
          paymentAccountId: req.body.payment_account_id || null,
          taxCodeId: req.body.tax_code_id || null,
        })
      } catch { /* l'apprentissage ne doit pas faire échouer la publication */ }
    } catch (e) {
      qbError = e.message
      qbField = e.field || null
    }
  }

  refreshStatuses(txn.account_id)
  mirrorSoon('ecriture')
  res.status(201).json({
    txn: getTxn(txn.id),
    achat_id: achatId,
    quickbooks_id,
    qbError,
    qbField,
  })
})

// Taux d'achat total d'un code de taxe : le formulaire « Ajouter » en déduit la
// taxe incluse dans le montant du relevé et l'affiche AVANT de publier.
router.get('/tax-code-rate/:taxCodeId', async (req, res) => {
  try {
    const { resolveTaxCodeRates } = await import('../services/quickbooks.js')
    const rates = await resolveTaxCodeRates(req.params.taxCodeId)
    const percent = rates.reduce((s, r) => s + (Number(r.percent) || 0), 0)
    res.json({ tax_code_id: req.params.taxCodeId, percent, rates })
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

// Lignes d'autres comptes qui pourraient être l'autre moitié du mouvement.
router.get('/transactions/:id/transfer-candidates', (req, res) => {
  const txn = getTxn(req.params.id)
  if (!txn) return res.status(404).json({ error: 'Not found' })
  res.json(findTransferCandidates(txn))
})

// Lie les deux lignes d'un virement interne, et pose l'écriture QuickBooks.
// body: { counterpart_txn_id, amount?, push_qb=true }
router.post('/transactions/:id/transfer', async (req, res) => {
  const txn = getTxn(req.params.id)
  if (!txn) return res.status(404).json({ error: 'Not found' })
  const other = getTxn(req.body?.counterpart_txn_id)

  try {
    linkTransfer(txn, other, { amount: req.body?.amount })
  } catch (e) {
    if (e instanceof BankActionError) return res.status(e.status).json({ error: e.message, field: e.field })
    throw e
  }

  let pushed = {}
  if (req.body?.push_qb !== false) {
    try {
      pushed = await pushTransferToQB(getTxn(txn.id), getTxn(other.id))
    } catch (e) {
      pushed = { qbError: e.message }
    }
  }

  refreshStatuses(txn.account_id)
  refreshStatuses(other.account_id)
  mirrorSoon('virement')
  res.json({ txn: getTxn(txn.id), counterpart: getTxn(other.id), ...pushed })
})

// Défait le lien (l'écriture QuickBooks, elle, reste — à annuler dans QB).
router.delete('/transactions/:id/transfer', (req, res) => {
  const txn = getTxn(req.params.id)
  if (!txn) return res.status(404).json({ error: 'Not found' })
  try {
    res.json(unlinkTransfer(txn))
  } catch (e) {
    if (e instanceof BankActionError) return res.status(e.status).json({ error: e.message, field: e.field })
    throw e
  }
})

// ── Le classeur Google (sens SORTANT uniquement) ─────────────────────────────
//
// La LECTURE du fichier TRX_Orisha est coupée depuis le 2026-09-15 : les
// relevés entrent par le dépôt de fichiers et c'est Boréal qui écrit le
// classeur. Relire ce qu'on vient d'écrire n'a plus de sens.
// Voir services/trxSheetMirror.js.
router.get('/trx-sheet/mirror', async (req, res) => {
  const { mirrorStatus } = await import('../services/trxSheetMirror.js')
  res.json(mirrorStatus())
})

router.post('/trx-sheet/mirror', async (req, res) => {
  const { syncMirror } = await import('../services/trxSheetMirror.js')
  try {
    res.json(await syncMirror({ trigger: 'manuel', force: true }))
  } catch (e) {
    res.status(400).json({ error: e.message })
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
