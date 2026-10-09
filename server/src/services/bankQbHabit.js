/**
 * La mémoire QuickBooks du relevé : ce que QuickBooks a fait, les fois d'avant,
 * d'une ligne au même libellé.
 *
 * Demande de Charles (2026-10-06) : « DEBOURSE MCR » ne proposait rien alors
 * que QuickBooks l'avait passé 113 fois en virement depuis la marge de crédit
 * (une règle QuickBooks le faisait). La mémoire du relevé (bankLabelMemory) ne
 * lisait que les dépenses liées à un achat de l'ERP ; tout le reste — virements
 * vers un compte que l'ERP ne suit pas, dépôts, dépenses saisies dans QuickBooks
 * — n'apprenait rien.
 *
 * Ici, chaque écriture QuickBooks déjà liée à une ligne du relevé est lue une
 * fois (`bank_qb_shapes`) et réduite à sa forme : virement vers quel compte,
 * dépôt dans quel compte, dépense à quel fournisseur. Pour une ligne ouverte,
 * on vote parmi les lignes passées au même libellé, sur le même compte, dans le
 * même sens. Lecture seule — la publication reste un clic (proposition qb_habit).
 */
import db from '../db/database.js'
import { labelKey, isWrapperKey } from './bankLabelMemory.js'

const TTL_MS = 60_000
let index = null
export function invalidateQbHabit() { index = null }

// Le type stocké sur la ligne → l'entité QuickBooks à interroger.
const ENTITY = { transfer: 'Transfer', deposit: 'Deposit', expense: 'Purchase', check: 'Purchase', creditcardcredit: 'Purchase' }

const ids = (account) => String(account?.qb_account_id || '').split(',').map((s) => s.trim()).filter(Boolean)
const ref = (r) => (r?.value ? { id: String(r.value), name: r.name || null } : null)

/**
 * La forme d'une écriture QuickBooks, vue depuis le compte du relevé. PUR.
 * `bankQbIds` : les comptes QuickBooks du compte bancaire (le contre-compte est
 * l'autre côté du virement).
 */
export function shapeOf(type, e, bankQbIds = []) {
  if (!e) return null
  const memo = (e.PrivateNote || '').trim() || null
  if (type === 'transfer') {
    const from = ref(e.FromAccountRef)
    const to = ref(e.ToAccountRef)
    if (!from || !to) return null
    const out = bankQbIds.includes(to.id) && !bankQbIds.includes(from.id)
    const other = out ? from : to
    return { k: 'transfer', acct: other.id, name: other.name, memo }
  }
  if (type === 'deposit') {
    const lines = (e.Line || []).filter((l) => l.Amount)
    // Un dépôt qui encaisse des paiements clients ne se refait pas à l'identique.
    if (!lines.length || lines.some((l) => (l.LinkedTxn || []).length)) return { k: 'deposit_linked' }
    const accts = [...new Set(lines.map((l) => l.DepositLineDetail?.AccountRef?.value).filter(Boolean))]
    if (accts.length !== 1) return { k: 'deposit_multi' }
    const l = lines[0]
    return {
      k: 'deposit', acct: String(accts[0]), name: l.DepositLineDetail.AccountRef.name || null,
      memo: (l.Description || '').trim() || memo,
    }
  }
  // Purchase : dépense, chèque, crédit de carte.
  const lines = (e.Line || []).filter((l) => l.AccountBasedExpenseLineDetail?.AccountRef?.value)
  const accts = [...new Set(lines.map((l) => String(l.AccountBasedExpenseLineDetail.AccountRef.value)))]
  const taxes = [...new Set(lines.map((l) => l.AccountBasedExpenseLineDetail.TaxCodeRef?.value).filter(Boolean))]
  const first = lines[0]?.AccountBasedExpenseLineDetail
  return {
    k: 'expense',
    vendor: e.EntityRef?.name || null,
    acct: accts.length === 1 ? accts[0] : null,
    name: accts.length === 1 ? first.AccountRef.name || null : null,
    tax: taxes.length === 1 ? String(taxes[0]) : null,
    memo,
  }
}

// Préparées à l'usage : la table naît d'une migration, après le chargement des modules.
const getShape = { get: (...a) => db.prepare('SELECT shape FROM bank_qb_shapes WHERE qb_type=? AND qb_id=?').get(...a) }
const putShape = { run: (...a) => db.prepare(`
  INSERT INTO bank_qb_shapes (qb_type, qb_id, shape) VALUES (?, ?, ?)
  ON CONFLICT(qb_type, qb_id) DO UPDATE SET shape=excluded.shape, fetched_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
`).run(...a) }

const PER_GROUP = 12

// Les lignes passées liées à QuickBooks, groupées par (compte, libellé, sens).
function pastLines() {
  return db.prepare(`
    SELECT t.id, t.account_id, t.txn_date, t.amount, t.details, t.description, t.qb_txn_type, t.qb_txn_id, b.qb_account_id
    FROM bank_transactions t JOIN bank_accounts b ON b.id = t.account_id
    WHERE t.deleted_at IS NULL AND t.qb_txn_id IS NOT NULL
      AND t.qb_txn_type IN ('transfer','deposit','expense','check','creditcardcredit')
      AND t.txn_date >= date('now', '-30 months')
    ORDER BY t.txn_date DESC
  `).all()
}

const groupKey = (t, key) => `${t.account_id}|${key}|${t.amount > 0 ? '+' : '-'}`

/**
 * Lit dans QuickBooks les formes qui manquent : les PER_GROUP plus récentes de
 * chaque libellé. Par lots de 30 identifiants par requête.
 */
export async function fillQbShapes({ max = 2000, query = null } = {}) {
  const groups = new Map()
  for (const t of pastLines()) {
    const key = labelKey(t)
    if (!key) continue
    const g = groupKey(t, key)
    const list = groups.get(g) || []
    if (list.length < PER_GROUP) { list.push(t); groups.set(g, list) }
  }
  const missing = new Map() // entité → [{type, id, bank}]
  let n = 0
  for (const list of groups.values()) {
    for (const t of list) {
      if (n >= max) break
      if (getShape.get(t.qb_txn_type, t.qb_txn_id)) continue
      const ent = ENTITY[t.qb_txn_type]
      if (!missing.has(ent)) missing.set(ent, [])
      missing.get(ent).push({ type: t.qb_txn_type, id: t.qb_txn_id, bank: ids({ qb_account_id: t.qb_account_id }) })
      n++
    }
  }
  const run = query || (async (q) => {
    const { qbGet } = await import('../connectors/quickbooks.js')
    return qbGet(`/query?query=${encodeURIComponent(q)}`)
  })
  let fetched = 0
  const errors = []
  for (const [ent, items] of missing) {
    const uniq = [...new Map(items.map((i) => [i.id, i])).values()]
    for (let i = 0; i < uniq.length; i += 30) {
      const chunk = uniq.slice(i, i + 30)
      try {
        const res = await run(`SELECT * FROM ${ent} WHERE Id IN (${chunk.map((c) => `'${c.id}'`).join(',')}) MAXRESULTS 30`)
        const found = new Map((res?.QueryResponse?.[ent] || []).map((e) => [String(e.Id), e]))
        for (const c of items.filter((x) => chunk.some((y) => y.id === x.id))) {
          const e = found.get(String(c.id))
          // Introuvable (supprimée dans QuickBooks) : on le retient aussi, pour
          // ne pas la redemander à chaque passage.
          putShape.run(c.type, String(c.id), JSON.stringify(e ? shapeOf(c.type, e, c.bank) : { k: 'missing' }))
          fetched++
        }
      } catch (e) { errors.push(`${ent}: ${e.message}`) }
    }
  }
  if (fetched) invalidateQbHabit()
  return { wanted: n, fetched, errors }
}

function load() {
  if (index && Date.now() - index.at < TTL_MS) return index
  const shapes = new Map(db.prepare('SELECT qb_type, qb_id, shape FROM bank_qb_shapes').all()
    .map((r) => [`${r.qb_type}|${r.qb_id}`, JSON.parse(r.shape || 'null')]))
  const byGroup = new Map()
  for (const t of pastLines()) {
    const shape = shapes.get(`${t.qb_txn_type}|${t.qb_txn_id}`)
    if (!shape) continue
    const key = labelKey(t)
    if (!key) continue
    const g = groupKey(t, key)
    if (!byGroup.has(g)) byGroup.set(g, [])
    byGroup.get(g).push({ id: t.id, qb: t.qb_txn_id, date: t.txn_date, amount: Math.abs(t.amount), shape })
  }
  index = { at: Date.now(), byGroup }
  return index
}

// Ce qu'on vote : la façon de refaire l'écriture.
const signature = (s) => (s.k === 'transfer' || s.k === 'deposit' ? `${s.k}:${s.acct}`
  : s.k === 'expense' ? `expense:${s.vendor || ''}:${s.acct || ''}` : s.k)

/**
 * Ce que QuickBooks a fait des lignes passées au même libellé.
 *
 * @returns null, ou { kind, account_id, account_name, memo, vendor, tax_code_id,
 *          n, total, strong, source }
 */
export function qbHabitFor(txn, { before = null } = {}) {
  if (!txn) return null
  const key = labelKey(txn)
  if (!key) return null
  let pool = (load().byGroup.get(groupKey(txn, key)) || [])
    .filter((l) => l.id !== txn.id && (!before || l.date < before))
  const amt = Math.abs(txn.amount)
  const rel = (l) => Math.abs(l.amount - amt) / Math.max(amt, 1)
  // « COMPTE DIVERS », « VIREMENT INTERAC » : seules les fois au même montant parlent.
  if (isWrapperKey(key)) pool = pool.filter((l) => rel(l) <= 0.03)
  const seen = new Set()
  pool = pool.filter((l) => (seen.has(l.qb) ? false : seen.add(l.qb)))
  if (!pool.length) return null

  const day = Date.parse(txn.txn_date || new Date().toISOString())
  const m = new Map()
  let total = 0
  for (const l of pool) {
    const w = Math.pow(0.5, Math.max(0, (day - Date.parse(l.date)) / (365 * 86400_000)))
    total += w
    const sig = signature(l.shape)
    const e = m.get(sig) || { sig, w: 0, n: 0, shape: l.shape, last: l.date }
    e.w += w; e.n++
    m.set(sig, e)
  }
  const top = [...m.values()].sort((a, b) => b.w - a.w)[0]
  const share = top.w / total
  const s = top.shape
  const strong = ['transfer', 'deposit', 'expense'].includes(s.k)
    && ((top.n >= 3 && share >= 0.7) || (top.n >= 2 && share === 1))
  const memos = pool.filter((l) => signature(l.shape) === top.sig).map((l) => l.shape.memo).filter(Boolean)
  const memo = memos.length && memos.filter((x) => x === memos[0]).length / memos.length >= 0.6 ? memos[0] : null
  return {
    kind: s.k, account_id: s.acct || null, account_name: s.name || null,
    vendor: s.vendor || null, tax_code_id: s.tax || null, memo,
    n: top.n, total: pool.length, strong, last_date: top.last,
    source: top.n >= pool.length ? `déjà fait ${top.n} fois pour ce libellé` : `déjà fait ${top.n} fois sur ${pool.length} pour ce libellé`,
  }
}

/**
 * Des exemples réels, par compte : quelques libellés que QuickBooks a déjà
 * passés à chaque compte. Sert d'aide-mémoire à la déduction (bankAiGuess).
 */
export function accountExamples({ perAccount = 3, sign = '-' } = {}) {
  const by = new Map()
  for (const [g, list] of load().byGroup) {
    if (!g.endsWith(`|${sign}`)) continue
    const label = g.split('|').slice(1, -1).join('|')
    const s = list[0]?.shape
    if (!s?.acct || !['transfer', 'deposit', 'expense'].includes(s.k)) continue
    const e = by.get(s.acct) || { acct: s.acct, labels: [], n: 0 }
    e.n += list.length
    if (e.labels.length < perAccount && !e.labels.includes(label)) e.labels.push(label)
    by.set(s.acct, e)
  }
  return [...by.values()].sort((a, b) => b.n - a.n)
}
