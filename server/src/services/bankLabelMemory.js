/**
 * La mémoire du relevé : ce qu'on a déjà fait pour CE libellé.
 *
 * Demande de Charles (2026-10-06) : « regarde les transactions du passé, ce qui
 * a été fait ». Le dossier de préparation ne retrouvait le fournisseur que par
 * une règle, un motif de fiche, ou le nom écrit tel quel dans le libellé — un
 * libellé comme « DT NETHRIS PAIE », « Transfer fee — Fee » ou « PMTS
 * ENTREPRISES » restait muet alors que l'écriture avait été passée vingt fois.
 *
 * Chaque ligne passée liée à une écriture PUBLIÉE (achat apparié, ou écriture
 * QuickBooks retrouvée au grand livre) enseigne : ce libellé, sur un compte de
 * cette devise, a été porté à ce fournisseur, ce compte, ce code de taxe, ce
 * mémo. On cherche les lignes au même libellé épuré, puis aux libellés proches,
 * on vote — pondéré par la proximité du montant et la fraîcheur — et l'on ne
 * répond que si le vote est net. Lecture seule.
 */
import db from '../db/database.js'
import { stripBankNoise } from './scrapers/vendorFromBankLabel.js'
import { ruleLabelOf } from './bankRules/match.js'
import { patternStrength } from './bankRules/verify.js'

const TTL_MS = 60_000
let index = null

export function invalidateLabelMemory() { index = null }

// Le montant d'origine que la banque accole (« Montant initial en devise CAD
// 150,38 ») change à chaque ligne : il ne dit rien du bénéficiaire.
const FX_TAIL = /\s*(montant initial en devise|original amount for currency).*$/i
// « — IN_PROGRESS », « — Card Payment » : l'état et la nature que Venn accole.
const VENN_STATE = /\s+[—–-]\s+(in_progress|completed|pending|en attente)\s*$/i

// Le vocabulaire des virements et prélèvements, en plus de celui des règles.
const WRAPPER_WORDS = new Set(['interac', 'payer', 'divers', 'retrait', 'direct', 'internet', 'accesd',
  'preautorise', 'autorise', 'mensuelle', 'envoi', 'recu', 'online', 'bill', 'pay', 'paye', 'par'])

export function labelKey(txn) {
  // « PAYPAL *AICAMERCHAN », « GOOGLE *WORKSPACE » : après l'astérisque, le
  // vrai marchand — on ne retire que les codes qui portent des chiffres.
  const raw = ruleLabelOf(txn).replace(FX_TAIL, '').replace(VENN_STATE, '').replace(/\*([a-z]{3,})\b/gi, ' $1')
  return stripBankNoise(raw).split(' ').filter((w) => w && !/^\d+$/.test(w)).join(' ')
}

// Un libellé d'emballage (« VIREMENT INTERAC », « COMPTE A PAYER ») ne nomme personne.
export const isWrapperKey = (key) => !patternStrength(String(key || '').split(' ').filter((w) => !WRAPPER_WORDS.has(w)).join(' ')).ok

const fold = (v) => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const tokensOf = (key) => new Set(key.split(' ').filter((w) => w.length >= 3))

function accountOfAchat(r) {
  if (r.expense_account_id) return r.expense_account_id
  try { return JSON.parse(r.lines || '[]')[0]?.account_id || null } catch { return null }
}

// Un mémo n'est une habitude que s'il dit la nature, pas le libellé recopié.
const looksLikeBankLabel = (v) => /(montant initial en devise|original amount for currency)/i.test(v) || /\s{3,}/.test(v)

function load() {
  if (index && Date.now() - index.at < TTL_MS) return index
  const rows = db.prepare(`
    SELECT t.id, t.account_id, t.matched_type, a.id AS achat_id, t.txn_date, t.amount, t.details, t.description, b.currency,
           a.vendor, a.expense_account_id, a.lines, a.tax_code_id, a.qb_memo, a.type
    FROM bank_transactions t
    JOIN bank_accounts b ON b.id = t.account_id
    JOIN achats_fournisseurs a ON (
      (t.matched_type = 'achat' AND a.id = t.matched_id)
      OR (t.matched_id IS NULL AND t.qb_txn_type IN ('expense', 'check', 'creditcardcredit') AND a.quickbooks_id = t.qb_txn_id))
    WHERE t.deleted_at IS NULL AND t.amount < 0 AND a.quickbooks_id IS NOT NULL
      AND a.vendor IS NOT NULL AND TRIM(a.vendor) <> ''
      AND t.txn_date >= date('now', '-30 months')
  `).all()
  const lines = rows.map((r) => {
    const key = labelKey(r)
    return {
      id: r.id, achat: r.achat_id, erp: r.matched_type === 'achat', account_id: r.account_id, date: r.txn_date, amount: Math.abs(r.amount),
      currency: r.currency || 'CAD', key, tokens: tokensOf(key),
      vendor: r.vendor.trim(), account: accountOfAchat(r), tax: r.tax_code_id || '__none__',
      memo: (r.qb_memo || '').trim(), type: r.type || null,
    }
  }).filter((l) => l.key)
  const byKey = new Map()
  for (const l of lines) {
    if (!byKey.has(l.key)) byKey.set(l.key, [])
    byKey.get(l.key).push(l)
  }
  index = { at: Date.now(), lines, byKey }
  return index
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / (a.size + b.size - inter)
}

// `share` se calcule sur TOUT le poids, valeurs vides comprises : un mémo écrit
// deux fois sur trente n'est pas une habitude.
function vote(items, pick) {
  const m = new Map()
  let total = 0
  for (const it of items) {
    total += it.w
    const v = pick(it.line)
    if (v == null || v === '') continue
    const e = m.get(v) || { value: v, w: 0, n: 0, erp: false }
    e.w += it.w; e.n++; e.erp ||= it.line.erp
    m.set(v, e)
  }
  const list = [...m.values()].sort((a, b) => b.w - a.w)
  return { top: list[0] || null, share: list[0] && total ? list[0].w / total : 0, list }
}

/**
 * Ce que les lignes passées au même libellé disent de celle-ci.
 *
 * @param options.before    n'apprendre que des lignes antérieures (mesure)
 * @param options.excludeId la ligne elle-même
 * @returns null, ou { vendor, expense_account_id, tax_code_id, memo, qb_type,
 *          n, total, exact, source } — chaque valeur seulement si le vote est net.
 */
export function learnedFromLabel(txn, account, { before = null, excludeId = null } = {}) {
  if (!txn || !(txn.amount < 0)) return null
  const key = labelKey(txn)
  if (!key) return null
  const { lines, byKey } = load()
  const currency = account?.currency || 'CAD'
  const ok = (l) => l.currency === currency && l.id !== (excludeId || txn.id) && (!before || l.date < before)

  // Le même compte d'abord : un même libellé sur deux comptes n'a pas
  // toujours le même sens (frais de la banque de CE compte).
  const sameAccount = (list) => (list.some((l) => l.account_id === txn.account_id) ? list.filter((l) => l.account_id === txn.account_id) : list)
  let pool = sameAccount((byKey.get(key) || []).filter(ok))
  let exact = true
  if (!pool.length) {
    // Pas de jumeau exact : les libellés proches (même marchand, autre
    // succursale ou autre numéro de commande), à condition de partager le
    // premier mot — c'est le nom du marchand, le reste est de la géographie.
    exact = false
    const toks = tokensOf(key)
    const first = key.split(' ')[0]
    pool = sameAccount(lines.filter((l) => ok(l) && l.key.split(' ')[0] === first && jaccard(toks, l.tokens) >= 0.5))
    if (!pool.length) return null
  }

  const amt = Math.abs(txn.amount)
  const rel = (l) => Math.abs(l.amount - amt) / Math.max(amt, 1)
  // Un libellé d'emballage (« VIREMENT INTERAC », « COMPTE A PAYER ») ne nomme
  // personne : seules les fois au même montant parlent de ce bénéficiaire-là.
  const wrapper = isWrapperKey(key)
  if (wrapper) {
    pool = pool.filter((l) => rel(l) <= 0.03)
    if (!pool.length) return null
  }
  const day = Date.parse(txn.txn_date || new Date().toISOString())
  const weigh = (l) => {
    const months = Math.max(0, (day - Date.parse(l.date)) / (30.4 * 86400_000))
    const rec = Math.pow(0.5, months / 12)
    const r = rel(l)
    // Le montant départage un libellé d'emballage (« COMPTE DIVERS » porte la
    // paie ET le paiement de la carte) : très proche compte quatre fois plus.
    const near = r <= 0.02 ? 4 : r <= 0.1 ? 2.5 : r <= 0.35 ? 1.3 : 1
    return rec * near
  }
  // Une écriture compte une fois, même liée à deux lignes (doublon de relevé).
  const seen = new Set()
  pool = pool.filter((l) => (seen.has(l.achat) ? false : seen.add(l.achat)))
  const items = pool.map((line) => ({ line, w: weigh(line) }))

  const v = vote(items, (l) => l.vendor)
  // Net = la majorité claire, et au moins deux fois — une seule fois suffit
  // quand le libellé est identique et qu'aucune autre voix ne s'y oppose.
  // Une liaison faite par l'ERP, ou un fournisseur dont le nom se lit dans le
  // libellé, corrobore. Une liaison retrouvée au grand livre sur le seul montant
  // peut être une coïncidence (une préautorisation Google de 2 $ jumelée à une
  // dépense FedEx de 2 $) : sans corroboration, il en faut trois.
  const named = v.top && fold(v.top.value).split(' ').some((w) => w.length >= 4 && !WRAPPER_WORDS.has(w) && key.includes(w))
  const corroborated = v.top && (v.top.erp || named)
  const strong = v.top && v.share >= (wrapper ? 0.85 : 0.7) && (v.top.n >= 3
    || (v.top.n >= 2 && corroborated)
    || (exact && !wrapper && v.list.length === 1 && corroborated))
  if (!strong) return { key, n: pool.length, exact, vendor: null, ambiguous: v.list.slice(0, 3).map((e) => e.value) }

  const same = items.filter((it) => it.line.vendor === v.top.value)
  const pickClear = (r, min = 0.6) => (r.top && r.share >= min ? r.top : null)
  const acct = pickClear(vote(same, (l) => l.account))
  const tax = pickClear(vote(same, (l) => l.tax))
  const memoV = vote(same, (l) => (l.memo && l.memo.length <= 80 && !looksLikeBankLabel(l.memo) ? l.memo : null))
  const memo = memoV.top && memoV.top.n >= 3 && memoV.share >= 0.5 ? memoV.top : null
  const type = pickClear(vote(same, (l) => l.type))

  const n = v.top.n
  // La source dit la force : « 11 fois sur 16 » n'a pas le poids de « 16 fois ».
  const said = (e) => (e ? (e.n >= n ? `déjà fait ${n} fois pour ce libellé` : `déjà fait ${e.n} fois sur ${n} pour ce libellé`) : null)
  const source = said(v.top)
  return {
    key, n, total: pool.length, exact,
    vendor: v.top.value,
    expense_account_id: acct?.value || null,
    tax_code_id: tax?.value || null,
    memo: memo?.value || null,
    qb_type: type?.value || null,
    source,
    sources: { expense_account_id: said(acct), tax_code_id: said(tax), memo: said(memo), qb_type: said(type) },
    last_date: same.map((it) => it.line.date).sort().pop() || null,
  }
}
