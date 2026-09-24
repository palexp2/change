/**
 * Les règles bancaires — l'équivalent de « Banque → Règles » de QuickBooks.
 *
 * Monté sous /api/bank/rules : aucune `location` nginx à ajouter, le préfixe
 * /erp/api/ est déjà proxié.
 *
 * Invariant tenu ici : **une règle prépare, elle ne publie pas**. Aucune route
 * de ce fichier n'écrit dans QuickBooks.
 */
import { Router } from 'express'
import multer from 'multer'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import {
  listRules, getRule, createRule, updateRule, deleteRule, previewRule, ruleDraftFromTxn, repairQbRules,
} from '../services/bankRules/store.js'
import { suggestRulesFromHistory } from '../services/bankRules/fromHistory.js'
import { habitsFromStatement } from '../services/bankRules/fromStatement.js'
import { housekeeping, archiveRules, restoreRules } from '../services/bankRules/housekeeping.js'
import { verifyRule, overlappingRules, suggestRelaxation } from '../services/bankRules/verify.js'
import { readQbRulesFile } from '../services/bankRules/importQb.js'
import { stripBankNoise } from '../services/scrapers/vendorFromBankLabel.js'
import { buildEntryDraft } from '../services/bankEntryDraft.js'

const router = Router()
router.use(requireAuth)

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } }).single('file')

// La liste, avec l'état de santé de chaque règle : combien de lignes elle
// attrape, et — si elle n'en attrape aucune — ce qu'il faudrait assouplir.
router.get('/', (req, res) => {
  const rules = listRules()
  res.json(rules.map((r) => {
    const check = verifyRule(r, { sample: 2 })
    return {
      ...r,
      covers: check.covers,
      a_traiter: check.a_traiter,
      checked: check.checked,
      disagree: check.disagree,
      warnings: check.warnings,
      relaxation: check.covers === 0 ? suggestRelaxation(r) : null,
    }
  }))
})

router.get('/suggestions', (req, res) => res.json(suggestRulesFromHistory()))

// L'atelier : les habitudes que le relevé raconte, prêtes à devenir des règles.
router.get('/habits', (req, res) => res.json(habitsFromStatement()))

// Le ménage : doublons, illisibles, sans trace, débordantes.
router.get('/housekeeping', (req, res) => res.json(housekeeping()))
router.post('/archive', (req, res) => res.json(archiveRules(req.body?.ids || [])))
router.post('/restore', (req, res) => res.json(restoreRules(req.body?.ids || [])))

// Au fil de l'eau : ce libellé revient-il assez pour mériter une règle ?
// Rendu au rail du rapprochement, qui ne propose rien en dessous de trois fois.
router.get('/opportunity/:txnId', (req, res) => {
  const txn = db.prepare('SELECT * FROM bank_transactions WHERE id=? AND deleted_at IS NULL').get(req.params.txnId)
  if (!txn) return res.status(404).json({ error: 'Not found' })
  const key = stripBankNoise([txn.details, txn.description].filter(Boolean).join(' '))
  const hit = habitsFromStatement({ limit: 400 }).find((h) => h.label_pattern === key)
  res.json(hit || null)
})

// Relire les conditions des règles importées avant qu'on sache les décoder.
router.post('/repair', (req, res) => res.json(repairQbRules()))

// « Cette règle couvrirait N lignes, et voici ce qu'elle contredit » — avant
// d'enregistrer quoi que ce soit. La vérification confronte la règle à ce qui a
// réellement été comptabilisé sur les lignes qu'elle attraperait.
router.post('/preview', (req, res) => {
  const rule = req.body || {}
  const check = verifyRule(rule)
  res.json({
    ...previewRule(rule),
    ...check,
    overlaps: overlappingRules(rule, listRules()),
  })
})

// La vérification d'une règle déjà enregistrée.
router.get('/:id/verify', (req, res) => {
  const rule = getRule(req.params.id)
  if (!rule) return res.status(404).json({ error: 'Not found' })
  res.json({ ...verifyRule(rule), overlaps: overlappingRules(rule, listRules()) })
})

// Une règle préremplie à partir d'une ligne du relevé — motif ET façon de
// comptabiliser. « Toujours faire ça pour ce libellé » ne veut rien dire si la
// règle ne retient pas ce qu'on vient de faire : quand la ligne porte déjà son
// achat, ce sont SES valeurs qui font foi ; sinon celles que le dossier a
// préparées. Un champ sans source reste vide.
function bookingFromTxn(txn) {
  if (txn.matched_type === 'achat' && txn.matched_id) {
    const a = db.prepare(`
      SELECT vendor, expense_account_id, tax_code_id, qb_memo, type FROM achats_fournisseurs WHERE id=?
    `).get(String(txn.matched_id))
    if (a?.expense_account_id || a?.vendor) {
      return {
        vendor_name: a.vendor || null,
        expense_account_id: a.expense_account_id || null,
        tax_code_id: a.tax_code_id || null,
        memo: a.qb_memo || null,
        qb_type: ['purchase', 'bill', 'cc_credit'].includes(a.type) ? a.type : null,
      }
    }
  }
  const account = db.prepare('SELECT * FROM bank_accounts WHERE id=?').get(txn.account_id)
  const f = buildEntryDraft(txn, account)?.fields || {}
  const val = (k) => (f[k]?.source ? f[k].value || null : null)
  return {
    vendor_name: val('vendor'),
    expense_account_id: val('expense_account_id'),
    tax_code_id: val('tax_code_id'),
    memo: val('memo'),
    qb_type: val('qb_type'),
  }
}

router.get('/draft-from-txn/:txnId', (req, res) => {
  const txn = db.prepare('SELECT * FROM bank_transactions WHERE id=? AND deleted_at IS NULL').get(req.params.txnId)
  if (!txn) return res.status(404).json({ error: 'Not found' })
  const draft = { ...ruleDraftFromTxn(txn, { stripBankNoise }), ...bookingFromTxn(txn) }
  res.json({ ...draft, preview: previewRule(draft) })
})

router.post('/', (req, res) => {
  try {
    res.status(201).json(createRule(req.body || {}, req.user.id))
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// Appliquer l'assouplissement proposé pour une règle qui n'attrape rien.
router.post('/:id/relax', (req, res) => {
  const rule = getRule(req.params.id)
  if (!rule) return res.status(404).json({ error: 'Not found' })
  const r = suggestRelaxation(rule)
  if (!r) return res.status(400).json({ error: 'Rien à assouplir — ce libellé n\'apparaît nulle part au relevé' })
  res.json(updateRule(rule.id, { conditions: r.conditions, label_pattern: r.pattern }))
})

router.patch('/:id', (req, res) => {
  if (!getRule(req.params.id)) return res.status(404).json({ error: 'Not found' })
  res.json(updateRule(req.params.id, req.body || {}))
})

router.delete('/:id', (req, res) => {
  if (!getRule(req.params.id)) return res.status(404).json({ error: 'Not found' })
  res.json(deleteRule(req.params.id))
})

// ── Import du fichier exporté de QuickBooks ─────────────────────────────────
//
// Deux temps, jamais un seul : on LIT le fichier et on montre ce que chaque
// règle deviendrait (`/import-qb/preview`), puis on enregistre ce que l'humain
// a retenu (`POST /` en lot). L'API QuickBooks ne donne pas les règles — le
// fichier est le seul chemin.

// Les listes QuickBooks, pour traduire les noms du fichier en identifiants.
async function resolvers() {
  const norm = (v) => String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
  const accountMap = new Map()
  const taxMap = new Map()
  try {
    const { loadAccountsCache } = await import('../services/quickbooks.js')
    const cache = await loadAccountsCache()
    for (const [id, { acctNum, name }] of cache.byId) {
      accountMap.set(norm(name), id)
      // « 5010 Transport » : QuickBooks exporte souvent le numéro devant.
      if (acctNum) {
        accountMap.set(norm(`${acctNum} ${name}`), id)
        accountMap.set(norm(acctNum), id)
      }
    }
  } catch { /* QuickBooks injoignable : les comptes seront simplement « introuvables » */ }
  try {
    const { qbGet } = await import('../connectors/quickbooks.js')
    const q = new URLSearchParams({ query: 'SELECT * FROM TaxCode WHERE Active = true MAXRESULTS 500' })
    const data = await qbGet(`/query?${q}`)
    for (const tc of data.QueryResponse?.TaxCode || []) taxMap.set(norm(tc.Name), String(tc.Id))
  } catch { /* idem */ }
  const profiles = db.prepare('SELECT id, name FROM vendor_profiles WHERE deleted_at IS NULL').all()
  const bankAccounts = db.prepare('SELECT id, name FROM bank_accounts WHERE deleted_at IS NULL').all()
  return {
    account: (n) => accountMap.get(norm(n)) || null,
    taxCode: (n) => taxMap.get(norm(n)) || null,
    vendor: (n) => profiles.find((p) => norm(p.name) === norm(n)) || null,
    bankAccount: (n) => bankAccounts.find((a) => norm(a.name) === norm(n))?.id || null,
  }
}

router.post('/import-qb/preview', upload, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' })
  try {
    const resolve = await resolvers()
    res.json(readQbRulesFile(req.file.buffer, resolve))
  } catch (e) {
    res.status(400).json({ error: `Fichier illisible : ${e.message}` })
  }
})

// Enregistre en lot les règles retenues dans l'aperçu.
router.post('/import-qb/commit', (req, res) => {
  const rules = Array.isArray(req.body?.rules) ? req.body.rules : []
  const created = []
  const failed = []
  for (const r of rules) {
    try { created.push(createRule({ ...r, origin: 'quickbooks' }, req.user.id)) }
    catch (e) { failed.push({ name: r?.name || '?', error: e.message }) }
  }
  res.json({ created: created.length, failed })
})

export default router
