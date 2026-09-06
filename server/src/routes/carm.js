// Douanes — relevé de transactions CARM (GCRA) de l'ASFC.
//
// Le relevé est importé à la main (copier-coller ou fichier CSV du portail —
// pas d'API publique côté gouvernement). Tout le reste est automatique :
// classification des lignes, ventilation droits / TPS, détection des lignes
// réglées par un courtier, lettrage des versements aux charges, puis
// proposition d'écritures QuickBooks poussées en un clic (POST /postings/post).
import { Router } from 'express'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { buildPartialUpdate } from '../utils/partialUpdate.js'
import { qbEntityUrl } from '../connectors/quickbooks.js'
import XLSX from 'xlsx'
import { importCarmStatement, previewCarmStatement, autoMatchCarm, cbsaReceipts } from '../services/carmImport.js'
import {
  carmAccountState, getCarmConfig, setCarmConfig, checkCarmBalanceAlert,
  backfillCarmCategories, CARM_CATEGORIES,
} from '../services/carmAccount.js'
import { CARM_KINDS } from '../services/carmRules.js'
import { recomputeCarm, carmImputation } from '../services/carmPosting.js'
import { previewCarmPostings, postCarmGroups, unpostCarmGroup } from '../services/carmQb.js'
import { logSync } from '../services/syncLog.js'

const router = Router()
router.use(requireAuth)

// Le portail laisse télécharger le relevé en CSV ou en Excel, et les CSV
// gouvernementaux sortent parfois en UTF-16 (Excel Windows) ou en latin-1.
// Le client envoie donc le fichier brut en base64 et c'est ici qu'on le
// ramène à du texte tabulaire ; un collage direct passe par `text`.
function decodeStatement({ text, file_base64: b64, filename = '' }) {
  if (!b64) return String(text || '')
  const buf = Buffer.from(b64, 'base64')
  const isZip = buf[0] === 0x50 && buf[1] === 0x4b // xlsx
  const isOle = buf[0] === 0xd0 && buf[1] === 0xcf // xls
  if (isZip || isOle || /\.xlsx?$/i.test(filename)) {
    const wb = XLSX.read(buf, { type: 'buffer', cellDates: true })
    // La feuille la plus fournie gagne (le portail ajoute parfois un onglet
    // « Criteria » avec les filtres du rapport).
    let best = '', bestLen = -1
    for (const name of wb.SheetNames) {
      const ws = wb.Sheets[name]
      // Les dates Excel sortiraient au format d'affichage du fichier (« 7/15/26 »,
      // mois d'abord ou jour d'abord selon la locale de l'auteur) : on les fige
      // en ISO avant la conversion, plus d'ambiguïté à l'analyse.
      for (const ref of Object.keys(ws)) {
        const cell = ws[ref]
        if (ref[0] !== '!' && cell?.v instanceof Date) {
          const dt = cell.v
          ws[ref] = { t: 's', v: `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}` }
        }
      }
      const csv = XLSX.utils.sheet_to_csv(ws, { raw: false, blankrows: false })
      if (csv.length > bestLen) { bestLen = csv.length; best = csv }
    }
    return best
  }
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le')
  if (buf[0] === 0xfe && buf[1] === 0xff) return buf.swap16().toString('utf16le')
  const utf8 = buf.toString('utf8')
  // Beaucoup de U+FFFD → ce n'était pas de l'UTF-8 : on retombe en latin-1.
  const bad = (utf8.match(/�/g) || []).length
  return bad > utf8.length / 200 ? buf.toString('latin1') : utf8
}

function receiptQbUrl(row) {
  if (!row.receipt_qb_id) return null
  const entity = row.receipt_qb_type === 'bill' ? 'bill'
    : row.receipt_qb_type === 'cc_credit' ? 'creditcardcredit'
    : 'expense'
  return qbEntityUrl(entity, row.receipt_qb_id)
}

// GET /api/carm/transactions — relevé + reçus ASFC de l'extracteur + sommaire.
// L'appariement auto tourne au passage : un reçu fraîchement extrait se lie
// tout seul à sa transaction sans action de l'utilisateur.
router.get('/transactions', (req, res) => {
  autoMatchCarm()
  backfillCarmCategories()
  // Classification, paires courtier, lettrage FIFO et états de comptabilisation
  // sont recalculés à la lecture : la page montre toujours l'imputation à jour.
  recomputeCarm()
  const transactions = db.prepare(`
    SELECT t.*, sr.receipt_date, sr.total AS receipt_total, sr.company AS receipt_company,
           sr.original_name AS receipt_filename, sr.quickbooks_id AS receipt_qb_id,
           sr.quickbooks_type AS receipt_qb_type
    FROM carm_transactions t
    LEFT JOIN sale_receipts sr ON sr.id = t.sale_receipt_id
    WHERE t.deleted_at IS NULL
    ORDER BY t.transaction_date DESC, t.created_at DESC
  `).all()
  for (const t of transactions) t.receipt_qb_url = receiptQbUrl(t)

  const linkedIds = new Set(transactions.filter(t => t.sale_receipt_id).map(t => t.sale_receipt_id))
  const receipts = cbsaReceipts().map(r => ({
    ...r,
    linked: linkedIds.has(r.id),
    quickbooks_url: r.quickbooks_id
      ? qbEntityUrl(r.quickbooks_type === 'bill' ? 'bill' : 'expense', r.quickbooks_id)
      : null,
  }))

  // Solde au relevé = solde de la transaction la plus récente qui en porte un.
  // Le solde du compte, lui, vient du service : solde d'ouverture saisi +
  // paiements − charges (le relevé du portail n'exporte que l'activité).
  const withBalance = transactions.find(t => t.balance != null)
  const summary = {
    balance: withBalance?.balance ?? null,
    balance_date: withBalance?.transaction_date ?? null,
    count: transactions.length,
    unmatched: transactions.filter(t => !t.sale_receipt_id).length,
    receipts_to_push: receipts.filter(r => !r.quickbooks_id).length,
  }
  const imputation = carmImputation()
  const allocations = imputation.allocations.map(a => ({
    payment_txn_id: a.payment_txn_id, charge_txn_id: a.charge_txn_id, amount: a.amount, method: a.method,
  }))
  for (const t of transactions) t.qb_url = t.qb_txn_id ? qbEntityUrl(t.qb_txn_type === 'purchase' ? 'expense' : t.qb_txn_type, t.qb_txn_id) : null
  res.json({ transactions, receipts, summary, allocations, state: carmAccountState(), config: getCarmConfig() })
})

// PUT /api/carm/config — solde d'ouverture, seuil d'alerte et comptes
// d'imputation. Persistés dans action_config de l'automation système
// sys_carm_balance_alert, comme la trésorerie (une seule source de vérité,
// éditable aussi depuis la page Automations).
router.put('/config', (req, res) => {
  const b = req.body || {}
  if (b.opening_date != null && b.opening_date !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(String(b.opening_date))) {
    return res.status(400).json({ error: 'opening_date invalide (AAAA-MM-JJ)' })
  }
  for (const k of ['opening_balance', 'threshold']) {
    if (b[k] != null && b[k] !== '' && !Number.isFinite(Number(String(b[k]).replace(',', '.')))) {
      return res.status(400).json({ error: `${k} doit être un montant` })
    }
  }
  try {
    const cfg = setCarmConfig(b)
    res.json({ config: cfg, state: carmAccountState() })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// POST /api/carm/import/preview { text | file_base64 } — ce que le parseur
// comprend du relevé, avant toute écriture : colonnes retenues, réparations,
// lignes déjà connues, lignes illisibles. Alimente l'aperçu de la modale.
router.post('/import/preview', (req, res) => {
  let text
  try { text = decodeStatement(req.body || {}) }
  catch { return res.status(400).json({ error: 'Fichier illisible — exporter le relevé en CSV ou Excel depuis le portail' }) }
  if (!text.trim()) return res.status(400).json({ error: 'Relevé vide — coller les lignes du portail CARM' })
  if (text.length > 4_000_000) return res.status(400).json({ error: 'Relevé trop volumineux' })
  try {
    res.json({ ...previewCarmStatement(text), text })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// POST /api/carm/import { text | file_base64 } — import idempotent d'un relevé
// collé/déposé.
router.post('/import', (req, res) => {
  let text
  try { text = decodeStatement(req.body || {}) }
  catch { return res.status(400).json({ error: 'Fichier illisible — exporter le relevé en CSV ou Excel depuis le portail' }) }
  if (!text.trim()) return res.status(400).json({ error: 'Relevé vide — coller les lignes du portail CARM' })
  if (text.length > 4_000_000) return res.status(400).json({ error: 'Relevé trop volumineux' })
  try {
    const result = importCarmStatement(text, req.user.id)
    logSync('carm', 'manual', { status: 'success', modified: result.created })
    // Un relevé fraîchement importé change le solde : c'est le meilleur moment
    // pour vérifier le seuil. Détaché de la réponse — l'import ne doit pas
    // échouer parce que Slack est indisponible.
    checkCarmBalanceAlert({ trigger: 'import de relevé' })
      .catch(e => console.error('carm alert (import):', e.message))
    res.json({ ...result, state: carmAccountState() })
  } catch (e) {
    logSync('carm', 'manual', { status: 'error', error: e.message })
    res.status(400).json({ error: e.message })
  }
})

const PATCH_IMPACTS_POSTING = ['transaction_date', 'due_date', 'amount', 'category', 'kind', 'payer',
  'broker', 'duty_amount', 'gst_amount']

router.patch('/transactions/:id', (req, res) => {
  const existing = db.prepare('SELECT id, posting_state FROM carm_transactions WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })
  // Une ligne déjà dans les livres ne se modifie plus à la légère : il faut
  // d'abord annuler l'écriture dans QuickBooks.
  if (existing.posting_state === 'comptabilise'
    && PATCH_IMPACTS_POSTING.some(k => req.body?.[k] !== undefined)) {
    return res.status(409).json({ error: 'Ligne déjà comptabilisée dans QuickBooks — annuler l\'écriture avant de la modifier' })
  }
  if (req.body?.kind != null && !CARM_KINDS.includes(String(req.body.kind))) {
    return res.status(400).json({ error: `kind invalide (${CARM_KINDS.join(', ')})` })
  }
  if (req.body?.payer != null && !['nous', 'courtier', 'inconnu'].includes(String(req.body.payer))) {
    return res.status(400).json({ error: 'payer invalide (nous, courtier, inconnu)' })
  }
  if (req.body?.category != null && !CARM_CATEGORIES.includes(String(req.body.category))) {
    return res.status(400).json({ error: `category invalide (${CARM_CATEGORIES.join(', ')})` })
  }
  for (const k of ['duty_amount', 'gst_amount']) {
    if (req.body?.[k] != null && req.body[k] !== '' && !Number.isFinite(Number(req.body[k]))) {
      return res.status(400).json({ error: `${k} doit être un montant` })
    }
  }
  const { setClause, values, error } = buildPartialUpdate(req.body, {
    allowed: ['transaction_date', 'due_date', 'transaction_type', 'transaction_number', 'description',
      'amount', 'balance', 'notes', 'category', 'duty_amount', 'gst_amount',
      'party', 'detail', 'kind', 'payer', 'broker', 'split_source'],
    nonNullable: new Set(['transaction_date', 'amount']),
  })
  if (error) return res.status(400).json({ error })
  if (setClause) {
    db.prepare(`UPDATE carm_transactions SET ${setClause}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
      .run(...values, req.params.id)
    // Une correction à la main fait autorité : le moteur ne la réécrira plus.
    const manual = ['kind', 'payer', 'broker', 'duty_amount', 'gst_amount', 'category']
      .some(k => req.body?.[k] !== undefined) && req.body?.split_source === undefined
    if (manual) db.prepare(`UPDATE carm_transactions SET split_source = 'manuel' WHERE id = ?`).run(req.params.id)
    if (PATCH_IMPACTS_POSTING.some(k => req.body?.[k] !== undefined)) recomputeCarm()
  }
  res.json(db.prepare('SELECT * FROM carm_transactions WHERE id = ?').get(req.params.id))
})

router.delete('/transactions/:id', (req, res) => {
  const txn = db.prepare('SELECT posting_state FROM carm_transactions WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (txn?.posting_state === 'comptabilise') {
    return res.status(409).json({ error: 'Ligne déjà comptabilisée dans QuickBooks — annuler l\'écriture avant de la supprimer' })
  }
  db.prepare(`UPDATE carm_transactions SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND deleted_at IS NULL`)
    .run(req.params.id)
  recomputeCarm()
  res.json({ ok: true })
})

// Lien manuel transaction ↔ reçu (quand l'appariement auto n'a pas tranché).
router.post('/transactions/:id/link', (req, res) => {
  const txn = db.prepare('SELECT id FROM carm_transactions WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!txn) return res.status(404).json({ error: 'Not found' })
  const receiptId = String(req.body?.sale_receipt_id || '')
  const receipt = db.prepare('SELECT id FROM sale_receipts WHERE id = ? AND deleted_at IS NULL').get(receiptId)
  if (!receipt) return res.status(400).json({ error: 'Reçu introuvable' })
  // Un même reçu peut couvrir plusieurs lignes : l'ASFC éclate un paiement en
  // autant d'applications que de charges réglées (le versement de 500 $ du
  // 3 août apparaît en −297,32 et −202,68). On ne bloque donc pas le lien
  // multiple — l'appariement automatique le fait déjà par groupe.
  db.prepare(`UPDATE carm_transactions SET sale_receipt_id = ?, match_source = 'manuel',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(receiptId, req.params.id)
  res.json(db.prepare('SELECT * FROM carm_transactions WHERE id = ?').get(req.params.id))
})

router.post('/transactions/:id/unlink', (req, res) => {
  const txn = db.prepare('SELECT id FROM carm_transactions WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!txn) return res.status(404).json({ error: 'Not found' })
  db.prepare(`UPDATE carm_transactions SET sale_receipt_id = NULL, match_source = 'dissocié',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(req.params.id)
  res.json(db.prepare('SELECT * FROM carm_transactions WHERE id = ?').get(req.params.id))
})

// ── Comptabilisation ─────────────────────────────────────────────────────────

// Ce que le moteur s'apprête à écrire dans QuickBooks — aucune écriture ici.
router.get('/postings/preview', async (req, res) => {
  try {
    recomputeCarm()
    res.json(await previewCarmPostings())
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// Pousse les groupes prêts (tous par défaut). Le push n'est jamais automatique :
// c'est ce bouton, et lui seul, qui écrit dans les livres.
router.post('/postings/post', async (req, res) => {
  const ids = Array.isArray(req.body?.group_ids) ? req.body.group_ids.map(String) : null
  try {
    const result = await postCarmGroups({ groupIds: ids, userId: req.user.id })
    res.json({ ...result, state: carmAccountState() })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// Annule une écriture déjà comptabilisée (supprime la transaction QuickBooks,
// remet ses lignes en 'a_comptabiliser') — sert à reposer une écriture avec
// une version corrigée des règles de comptabilisation.
router.post('/postings/:qbTxnId/unpost', async (req, res) => {
  try {
    const n = await unpostCarmGroup(req.params.qbTxnId)
    recomputeCarm()
    res.json({ ok: true, lines: n, state: carmAccountState() })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// « Ne pas comptabiliser cette ligne » — décision de l'utilisateur, jamais
// réécrite par le moteur (préfixe manuel:).
router.post('/transactions/:id/skip', (req, res) => {
  const txn = db.prepare('SELECT posting_state FROM carm_transactions WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!txn) return res.status(404).json({ error: 'Not found' })
  if (txn.posting_state === 'comptabilise') return res.status(409).json({ error: 'Ligne déjà comptabilisée dans QuickBooks' })
  const reason = String(req.body?.reason || 'décision utilisateur').slice(0, 200)
  db.prepare(`UPDATE carm_transactions SET posting_state = 'non_comptabilise', skip_reason = ?,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(`manuel:${reason}`, req.params.id)
  res.json(db.prepare('SELECT * FROM carm_transactions WHERE id = ?').get(req.params.id))
})

// Remet une ligne dans le circuit automatique (annule un skip manuel ou une erreur).
router.post('/transactions/:id/unskip', (req, res) => {
  const txn = db.prepare('SELECT posting_state FROM carm_transactions WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!txn) return res.status(404).json({ error: 'Not found' })
  if (txn.posting_state === 'comptabilise') return res.status(409).json({ error: 'Ligne déjà comptabilisée dans QuickBooks' })
  db.prepare(`UPDATE carm_transactions SET posting_state = NULL, skip_reason = NULL, posting_error = NULL,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(req.params.id)
  recomputeCarm()
  res.json(db.prepare('SELECT * FROM carm_transactions WHERE id = ?').get(req.params.id))
})

export default router
