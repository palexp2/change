/**
 * Les règles bancaires en base : lecture, écriture, aperçu de portée.
 *
 * Invariant : **une règle prépare, elle ne publie pas**. Rien ici n'écrit dans
 * QuickBooks ni ne change l'état comptable d'une ligne ; le seul effet d'une
 * règle sur `bank_transactions` est la trace `applied_rule_id`, qui dit quelle
 * règle a rempli le dossier — et se défait.
 */
import db from '../../db/database.js'
import { resolveVendorProfileId } from '../vendorProfiles.js'
import { newRecordId } from '../../utils/recordId.js'
import { matchBankRule, ruleSpecificity, ruleLabelOf } from './match.js'
import { decodeQbConditions } from './qbConditions.js'

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`

// Cache court, même raison que le résolveur de fournisseurs : une règle éditée
// il y a deux minutes doit prendre effet tout de suite, mais on ne relit pas la
// table à chaque ligne d'un balayage de relevé.
const CACHE_TTL_MS = 15_000
let cache = null
let cachedAt = 0
export function invalidateBankRulesCache() { cache = null }

export function activeRules() {
  if (cache && Date.now() - cachedAt < CACHE_TTL_MS) return cache
  cachedAt = Date.now()
  cache = db.prepare(`
    SELECT * FROM bank_rules WHERE deleted_at IS NULL AND active = 1
    ORDER BY priority ASC, created_at DESC
  `).all()
  return cache
}

export function listRules({ includeInactive = true } = {}) {
  return db.prepare(`
    SELECT r.*, a.name AS account_name, v.name AS vendor_profile_name
    FROM bank_rules r
    LEFT JOIN bank_accounts a ON a.id = r.account_id
    LEFT JOIN vendor_profiles v ON v.id = r.vendor_profile_id
    WHERE r.deleted_at IS NULL ${includeInactive ? '' : 'AND r.active = 1'}
    ORDER BY r.priority ASC, r.name COLLATE NOCASE
  `).all()
}

export const getRule = (id) => db.prepare('SELECT * FROM bank_rules WHERE id=? AND deleted_at IS NULL').get(id)

// La règle qui s'applique à une ligne, si elle en a une.
export function ruleForTxn(txn) {
  return matchBankRule(txn, activeRules())
}

const FIELDS = [
  'name', 'priority', 'active', 'account_id', 'direction', 'label_pattern',
  'amount_min', 'amount_max', 'day_of_month', 'tolerance_days',
  'vendor_profile_id', 'vendor_name', 'expense_account_id', 'tax_code_id',
  'memo', 'qb_type', 'origin', 'conditions',
]

const clean = (body) => {
  const out = {}
  for (const k of FIELDS) {
    if (!(k in body)) continue
    const v = body[k]
    out[k] = v === '' ? null : v
  }
  return out
}

export function createRule(body = {}, userId = null) {
  const values = clean(body)
  const name = String(values.name || '').trim()
  if (!name) throw new Error('Nom requis')
  // Une règle sans condition attraperait tout le relevé : on la refuse.
  if (!values.conditions && !values.label_pattern && !values.amount_min && !values.amount_max
    && !values.day_of_month && !values.account_id) {
    throw new Error('Une règle a besoin d\'au moins une condition')
  }
  // Garde-fou : une règle dont le motif est encore la structure brute de
  // QuickBooks n'attraperait jamais rien. Elle est refusée plutôt qu'enregistrée
  // morte — c'est exactement ainsi que 27 règles importées sont passées inaperçues.
  if (/ruleConditions|ruleType/.test(String(values.label_pattern || '')) && !values.conditions) {
    throw new Error('Conditions QuickBooks illisibles — cette règle n\'attraperait aucune ligne')
  }
  // Ré-importer le même fichier corrige les règles en place au lieu d'en
  // empiler des doubles : même nom, même provenance ⇒ même règle.
  if (values.origin && values.origin !== 'manuel') {
    const twin = db.prepare('SELECT id FROM bank_rules WHERE name=? AND origin=? AND deleted_at IS NULL').get(name, values.origin)
    if (twin) return updateRule(twin.id, values)
  }
  // Une règle qui nomme un fournisseur est reliée à sa fiche : c'est ce lien
  // qui permet ensuite de préparer l'écriture avec ce que la fiche sait.
  if (!values.vendor_profile_id && values.vendor_name) {
    const vid = resolveVendorProfileId(values.vendor_name)
    if (vid) values.vendor_profile_id = vid
  }
  const id = newRecordId()
  const cols = ['id', 'created_by', ...Object.keys(values)]
  db.prepare(`INSERT INTO bank_rules (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(id, userId, ...Object.values(values))
  invalidateBankRulesCache()
  return getRule(id)
}

export function updateRule(id, body = {}) {
  const values = clean(body)
  if (!Object.keys(values).length) return getRule(id)
  const sets = Object.keys(values).map((k) => `${k}=?`).join(', ')
  db.prepare(`UPDATE bank_rules SET ${sets}, updated_at=${NOW} WHERE id=? AND deleted_at IS NULL`)
    .run(...Object.values(values), id)
  invalidateBankRulesCache()
  return getRule(id)
}

export function deleteRule(id) {
  db.prepare(`UPDATE bank_rules SET deleted_at=${NOW} WHERE id=?`).run(id)
  // La trace reste sur les lignes : on ne réécrit pas l'histoire d'un dossier
  // déjà préparé. Une ligne encore à traiter se recalcule sans la règle.
  db.prepare('UPDATE bank_transactions SET applied_rule_id=NULL WHERE applied_rule_id=? AND status=\'a_traiter\'').run(id)
  invalidateBankRulesCache()
  return { ok: true }
}

/**
 * « Cette règle couvrirait N lignes du relevé » — l'aperçu avant d'enregistrer.
 * Regarde les 18 derniers mois, toutes lignes confondues, et rend aussi les
 * premières pour qu'on voie SUR QUOI elle tombe.
 */
export function previewRule(rule, { limit = 8, months = 18 } = {}) {
  const rows = db.prepare(`
    SELECT id, account_id, txn_date, description, details, amount, status, matched_id
    FROM bank_transactions
    WHERE deleted_at IS NULL AND txn_date >= date('now', ?)
    ORDER BY txn_date DESC
  `).all(`-${months} months`)
  const hits = rows.filter((r) => ruleSpecificity(rule, r) > 0)
  return {
    count: hits.length,
    a_traiter: hits.filter((r) => r.status === 'a_traiter' && !r.matched_id).length,
    sample: hits.slice(0, limit).map((r) => ({
      id: r.id, txn_date: r.txn_date, label: ruleLabelOf(r), amount: r.amount, status: r.status,
    })),
  }
}

// Une règle préremplie à partir d'une ligne : ce que l'humain vient de voir.
// Le motif proposé est le libellé DÉBARRASSÉ de son bruit (ville, pays, numéro
// d'autorisation) — sinon la règle ne retomberait jamais sur une autre ligne.
export function ruleDraftFromTxn(txn, { stripBankNoise }) {
  const label = ruleLabelOf(txn)
  const pattern = stripBankNoise(label) || label
  return {
    name: pattern.slice(0, 40) || 'Nouvelle règle',
    label_pattern: pattern,
    account_id: null,
    direction: Number(txn.amount) < 0 ? 'sortie' : 'entree',
    priority: 100,
  }
}

// Marque la ligne du nom de la règle qui a rempli son dossier. Aucun état
// comptable ne bouge — c'est une trace, pas une comptabilisation.
export function stampRule(txnId, ruleId) {
  db.prepare(`UPDATE bank_transactions SET applied_rule_id=?, updated_at=${NOW} WHERE id=?`).run(ruleId, txnId)
  db.prepare(`UPDATE bank_rules SET hit_count=hit_count+1, last_applied_at=${NOW} WHERE id=?`).run(ruleId)
}


/**
 * Réparer les règles importées avant que l'on sache lire les conditions de
 * QuickBooks : leur structure brute dort dans le motif, il suffit de la
 * décoder. Idempotent — une règle déjà lisible n'est pas touchée.
 */
export function repairQbRules() {
  const rows = db.prepare("SELECT * FROM bank_rules WHERE deleted_at IS NULL AND conditions IS NULL AND label_pattern LIKE '%ruleType%'").all()
  let repaired = 0
  const unreadable = []
  for (const r of rows) {
    const decoded = decodeQbConditions(r.label_pattern)
    if (!decoded) { unreadable.push(r.name); continue }
    db.prepare(`UPDATE bank_rules SET conditions=?, label_pattern=?, direction=?, updated_at=${NOW} WHERE id=?`)
      .run(JSON.stringify({ mode: decoded.mode, terms: decoded.terms }), decoded.summary, decoded.direction || r.direction, r.id)
    repaired++
  }
  invalidateBankRulesCache()
  return { repaired, unreadable }
}
