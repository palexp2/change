// Recherche APPROFONDIE d'une ligne de relevé dans QuickBooks.
//
// Pourquoi ce service existe : l'appariement historique (bankQbLink.js) exige
// un montant au cent près, une date à ±4 jours et le bon compte QB. Toute
// écriture qui sort de ce cadre était déclarée « absente de QuickBooks » alors
// qu'elle y est — sur les 94 anomalies du 22 août 2026, 83 étaient de faux
// positifs de ce genre. Cinq causes, toutes traitées ici :
//
//   1. le grand livre était filtré sur les seuls types d'écriture traduisibles
//      en URL — les autres (« Transfert de fonds », ajustements…) étaient
//      jetés SILENCIEUSEMENT, donc invisibles pour l'audit ;
//   2. fenêtre de ±4 jours trop courte (une carte porte au relevé jusqu'à
//      10 jours après la transaction) ;
//   3. aucune tolérance de montant (frais bancaires, conversion de devise) ;
//   4. appariement glouton dans l'ordre des dates : sur trois lignes de
//      1 000 $ et une seule écriture QB, la mauvaise ligne prenait l'écriture
//      et les deux autres devenaient des anomalies ;
//   5. un virement interne est souvent comptabilisé du côté de l'AUTRE compte
//      — il faut donc chercher dans tous les comptes bancaires mappés, pas
//      seulement celui du relevé.
//
// La couleur du fichier TRX_Orisha (bank_transactions.sheet_color) sert de
// vérité déclarée : vert = comptabilisée ET rapprochée, jaune = comptabilisée.
// Une ligne verte introuvable ici est une VRAIE anomalie ; une ligne rouge
// introuvable est simplement du travail à faire.
import db from '../db/database.js'
import { qbGet, qbEntityUrl } from '../connectors/quickbooks.js'
import { TXN_TYPE_ENTITY } from './bankQbLink.js'

export const MATCH_LABELS = {
  exact: 'montant et date exacts',
  fenetre: 'même montant, date décalée',
  devise: 'montant en devise du compte',
  tolerance: 'montant proche (frais ou conversion)',
  autre_compte: 'écriture portée à un autre compte',
  agregat: 'plusieurs écritures QB pour une ligne',
  agregat_inverse: 'plusieurs lignes du relevé pour une écriture',
  conversion: 'conversion de devise (taux vérifié dans QuickBooks)',
}

// Une conversion de devise apparaît au relevé dans la devise du compte et dans
// QuickBooks dans celle de l'écriture : les deux montants ne seront JAMAIS
// égaux. On accepte un rapport dans la plage des taux USD↔CAD plausibles, et
// seulement quand la ligne s'annonce comme une conversion ou que l'écriture est
// un virement — jamais sur deux montants qui se ressemblent par hasard.
const FX_MIN = 1.15
const FX_MAX = 1.65
const CONVERSION_RE = /conversion|exchange|change de devise|currency|fx/i

const round2 = (n) => Math.round(n * 100) / 100

export function shiftDate(iso, days) {
  const d = new Date(`${iso}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export function dayDiff(a, b) {
  return Math.abs((new Date(`${a}T12:00:00Z`) - new Date(`${b}T12:00:00Z`)) / 86400000)
}

// ── Concordance de libellé ───────────────────────────────────────────────────
//
// Le relevé écrit « AMAZON.CA*R42HG7 TORONTO ON », QuickBooks « Amazon.ca ».
// On compare des jetons alphabétiques d'au moins 4 lettres : un seul jeton
// commun suffit à corroborer (les libellés bancaires sont bruités, on ne s'en
// sert jamais seul pour apparier — uniquement pour départager).
const STOP = new Set([
  'paiement', 'payment', 'virement', 'transfer', 'depot', 'deposit', 'retrait',
  'facture', 'invoice', 'carte', 'card', 'inc', 'ltd', 'ltee', 'corp', 'com',
  'internet', 'accesd', 'transaction', 'achat', 'purchase', 'debit', 'credit',
])

export function labelTokens(...parts) {
  const s = parts.filter(Boolean).join(' ')
    .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  const out = new Set()
  for (const tok of s.split(/[^a-z]+/)) {
    if (tok.length >= 4 && !STOP.has(tok)) out.add(tok)
  }
  return out
}

export function labelAffinity(txn, entry) {
  const a = labelTokens(txn.description, txn.details, txn.reference)
  const b = labelTokens(entry.name, entry.memo, entry.docNum)
  if (!a.size || !b.size) return 0
  for (const t of a) {
    if (b.has(t)) return 1
    for (const u of b) if (t.length >= 5 && (u.includes(t) || t.includes(u))) return 1
  }
  return 0
}

// ── Grand livre : index de TOUTES les écritures des comptes mappés ───────────

function walkRows(rows, out) {
  for (const r of rows || []) {
    if (r.Rows?.Row) walkRows(r.Rows.Row, out)
    if (r.ColData) out.push(r.ColData)
  }
  return out
}

// Toutes les colonnes utiles, et AUCUN filtrage par type : une écriture dont le
// type n'est pas traduisible en URL reste une écriture qui existe.
export async function fetchLedgerFull(qbAccountId, startDate, endDate) {
  const cols = 'tx_date,txn_type,name,memo,doc_num,debt_amt,credit_amt,is_cleared,nat_foreign_amount'
  const d = await qbGet(
    `/reports/GeneralLedger?start_date=${startDate}&end_date=${endDate}&account=${qbAccountId}&columns=${cols}`
  )
  const colKeys = (d.Columns?.Column || []).map((c) => c.MetaData?.find((m) => m.Name === 'ColKey')?.Value)
  const idx = (k) => colKeys.indexOf(k)
  const [iDate, iType, iName, iMemo, iDoc, iDebit, iCredit, iCleared, iForeign] =
    ['tx_date', 'txn_type', 'name', 'memo', 'doc_num', 'debt_amt', 'credit_amt', 'is_cleared', 'nat_foreign_amount'].map(idx)
  const entries = []
  for (const c of walkRows(d.Rows?.Row, [])) {
    const date = c[iDate]?.value || ''
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue // « Solde initial », totaux…
    const debit = Number(c[iDebit]?.value || 0)
    const credit = Number(c[iCredit]?.value || 0)
    const amount = round2(debit - credit)
    if (!amount) continue
    const typeCol = c[iType]
    const foreign = iForeign >= 0 ? Number(c[iForeign]?.value || 0) : 0
    entries.push({
      qbAccountId: String(qbAccountId),
      date,
      amount,
      // Montant en devise du compte quand QB le fournit (comptes USD) : le
      // relevé, lui, est toujours en devise du compte.
      foreign: foreign ? round2(Math.sign(amount) * Math.abs(foreign)) : null,
      type: typeCol?.value || null,
      entity: TXN_TYPE_ENTITY[typeCol?.value] || null,
      qbId: typeCol?.id ? String(typeCol.id) : null,
      name: c[iName]?.value || null,
      memo: iMemo >= 0 ? (c[iMemo]?.value || null) : null,
      docNum: iDoc >= 0 ? (c[iDoc]?.value || null) : null,
      cleared: String(c[iCleared]?.value || '').trim().toUpperCase() || null,
    })
  }
  return entries
}

// QuickBooks renvoie parfois les MÊMES écritures pour deux ids du même compte
// ERP (voir le gotcha « GeneralLedger double-compte sur comptes multi-ids ») :
// on garde la multiplicité maximale plutôt que la somme.
function mergeById(lists) {
  if (lists.length <= 1) return lists[0] || []
  const keyOf = (e) => `${e.qbId || ''}|${e.date}|${e.amount}`
  const kept = new Map()
  for (const list of lists) {
    const local = new Map()
    for (const e of list) {
      const k = keyOf(e)
      if (!local.has(k)) local.set(k, [])
      local.get(k).push(e)
    }
    for (const [k, arr] of local) {
      if (!kept.has(k) || kept.get(k).length < arr.length) kept.set(k, arr)
    }
  }
  return [...kept.values()].flat()
}

// Index partagé par tous les comptes : un seul aller-retour QB par compte QB,
// réutilisé pour la recherche « autre compte ».
export async function buildLedgerIndex(accounts, from, to) {
  const byAccount = new Map()
  const all = []
  for (const account of accounts) {
    const ids = String(account.qb_account_id || '').split(',').map((s) => s.trim()).filter(Boolean)
    if (!ids.length) continue
    const lists = []
    for (const id of ids) lists.push(await fetchLedgerFull(id, from, to))
    const entries = mergeById(lists).map((e) => ({ ...e, accountId: account.id, accountName: account.name }))
    byAccount.set(account.id, entries)
    all.push(...entries)
  }
  return { byAccount, all, from, to }
}

// ── Appariement ──────────────────────────────────────────────────────────────

const MAX_DAY_GAP = 30          // même compte
const MAX_DAY_GAP_OTHER = 10    // autre compte : preuve plus exigeante
const ACCEPT_COST = 6

// Tolérance de montant admise (frais bancaires, conversion de devise) : la
// ligne est appariée mais l'écart est CONSERVÉ et affiché (décision du
// 22 août 2026), jamais absorbé en silence.
export function amountTolerance(amount) {
  return Math.max(0.5, Math.abs(amount) * 0.02)
}

// Rapport de conversion plausible entre une ligne de relevé et une écriture.
export function fxRate(bankAmount, entryAmount) {
  const a = Math.abs(bankAmount)
  const b = Math.abs(entryAmount)
  if (!a || !b || Math.sign(bankAmount) !== Math.sign(entryAmount)) return null
  const r = a > b ? a / b : b / a
  return r >= FX_MIN && r <= FX_MAX ? round2(a / b) : null
}

// Coût d'un appariement candidat, ou null s'il est irrecevable.
function pairCost(txn, entry, sign, { sameAccount }) {
  const target = round2(sign * Number(txn.amount))
  const gap = dayDiff(txn.txn_date, entry.date)
  if (gap > (sameAccount ? MAX_DAY_GAP : MAX_DAY_GAP_OTHER)) return null

  let method = null
  let delta = 0
  if (Math.abs(entry.amount - target) < 0.011) {
    method = gap <= 4 ? 'exact' : 'fenetre'
  } else if (entry.foreign != null && Math.abs(entry.foreign - target) < 0.011) {
    method = 'devise'
  } else if (sameAccount && Math.abs(Math.abs(entry.amount) - Math.abs(target)) <= amountTolerance(target)
    && Math.sign(entry.amount) === Math.sign(target)) {
    method = 'tolerance'
    delta = round2(entry.amount - target)
  } else {
    return null
  }
  if (!sameAccount) method = 'autre_compte'

  let cost = gap * 0.12
  if (method === 'tolerance') cost += 2 + Math.abs(delta) / Math.max(1, Math.abs(target))
  if (method === 'devise') cost += 0.2
  if (!sameAccount) cost += 3
  const affinity = labelAffinity(txn, entry)
  if (affinity) cost -= 1.5
  else if (!sameAccount) cost += 1 // un autre compte SANS libellé concordant reste douteux
  if (entry.cleared === 'C' || entry.cleared === 'R') cost -= 0.3
  return cost <= ACCEPT_COST ? { cost, method, delta, gap } : null
}

// Orientation du signe : le relevé d'une marge ou d'une carte note parfois
// l'inverse du grand livre. On vote sur le nombre d'appariements exacts.
export function detectSign(bankTxns, entries) {
  const count = (sign) => {
    const pool = new Map()
    for (const e of entries) {
      const k = e.amount.toFixed(2)
      pool.set(k, (pool.get(k) || 0) + 1)
    }
    let n = 0
    for (const t of bankTxns) {
      const k = round2(sign * Number(t.amount)).toFixed(2)
      const left = pool.get(k) || 0
      if (left > 0) { pool.set(k, left - 1); n++ }
    }
    return n
  }
  return count(1) >= count(-1) ? 1 : -1
}

// Appariement global : tous les couples recevables sont classés par coût
// croissant puis attribués une seule fois — c'est ce qui empêche la première
// ligne venue de voler l'écriture qui appartient à une autre.
function assign(bankTxns, entries, sign, sameAccount, results, usedEntries) {
  const pairs = []
  for (const t of bankTxns) {
    if (results.has(t.id)) continue
    for (const e of entries) {
      if (usedEntries.has(e)) continue
      const c = pairCost(t, e, sign, { sameAccount })
      if (c) pairs.push({ t, e, ...c })
    }
  }
  pairs.sort((a, b) => a.cost - b.cost)
  for (const p of pairs) {
    if (results.has(p.t.id) || usedEntries.has(p.e)) continue
    usedEntries.add(p.e)
    results.set(p.t.id, { entries: [p.e], method: p.method, delta: p.delta, gap: p.gap, cost: p.cost })
  }
}

// Conversion de devise : montants différents par construction, appariés sur le
// TAUX. Le taux obtenu est conservé pour affichage (jamais absorbé en silence).
function assignConversions(bankTxns, entries, sign, results, usedEntries) {
  const pairs = []
  for (const t of bankTxns) {
    if (results.has(t.id)) continue
    const declared = CONVERSION_RE.test(`${t.description || ''} ${t.details || ''}`)
    for (const e of entries) {
      if (usedEntries.has(e)) continue
      const gap = dayDiff(t.txn_date, e.date)
      if (gap > 3) continue
      if (!declared && !/virement|transfer/i.test(e.type || '')) continue
      const rate = fxRate(round2(sign * Number(t.amount)), e.amount)
      if (!rate) continue
      pairs.push({ t, e, gap, rate, cost: 3 + gap * 0.2 })
    }
  }
  pairs.sort((a, b) => a.cost - b.cost)
  for (const p of pairs) {
    if (results.has(p.t.id) || usedEntries.has(p.e)) continue
    usedEntries.add(p.e)
    results.set(p.t.id, {
      entries: [p.e], method: 'conversion', delta: round2(sign * Number(p.t.amount) - p.e.amount),
      rate: p.rate, gap: p.gap, cost: p.cost,
    })
  }
}

// Une ligne de relevé = plusieurs écritures QB du même jour (dépôt groupé, lot
// de paiements) : on cherche un sous-ensemble de 2 à 4 écritures non utilisées
// dont la somme fait le montant de la ligne.
function assignAggregates(bankTxns, entries, sign, results, usedEntries) {
  for (const t of bankTxns) {
    if (results.has(t.id)) continue
    const target = round2(sign * Number(t.amount))
    const pool = entries
      .filter((e) => !usedEntries.has(e) && dayDiff(t.txn_date, e.date) <= 5 && Math.sign(e.amount) === Math.sign(target))
      .slice(0, 14)
    const found = subsetSum(pool, target, 4)
    if (!found) continue
    found.forEach((e) => usedEntries.add(e))
    results.set(t.id, { entries: found, method: 'agregat', delta: 0, gap: Math.max(...found.map((e) => dayDiff(t.txn_date, e.date))), cost: 4 })
  }
}

export function subsetSum(pool, target, maxSize) {
  const res = []
  const dfs = (start, remaining, picked) => {
    if (res.length) return
    if (picked.length >= 2 && Math.abs(remaining) < 0.011) { res.push([...picked]); return }
    if (picked.length >= maxSize) return
    for (let i = start; i < pool.length; i++) {
      picked.push(pool[i])
      dfs(i + 1, round2(remaining - pool[i].amount), picked)
      picked.pop()
      if (res.length) return
    }
  }
  dfs(0, target, [])
  return res[0] || null
}

// Plusieurs lignes du relevé pour une seule écriture QB (paiement fractionné au
// relevé, regroupé dans QB).
function assignReverseAggregates(bankTxns, entries, sign, results, usedEntries) {
  const left = bankTxns.filter((t) => !results.has(t.id))
  for (const e of entries) {
    if (usedEntries.has(e)) continue
    const pool = left.filter((t) => !results.has(t.id) && dayDiff(t.txn_date, e.date) <= 5
      && Math.sign(sign * t.amount) === Math.sign(e.amount))
    if (pool.length < 2) continue
    const found = subsetSum(pool.map((t) => ({ ...t, amount: round2(sign * Number(t.amount)), txn: t })), e.amount, 4)
    if (!found) continue
    usedEntries.add(e)
    for (const f of found) {
      results.set(f.txn.id, { entries: [e], method: 'agregat_inverse', delta: 0, gap: dayDiff(f.txn.txn_date, e.date), cost: 4, shared: true })
    }
  }
}

// Recherche complète pour un compte. `index` vient de buildLedgerIndex().
// Retourne { matches: Map(txnId → match), unmatchedBank, unmatchedQb, sign }.
export function searchAccount(account, bankTxns, index) {
  const own = index.byAccount.get(account.id) || []
  const sign = detectSign(bankTxns, own)
  const results = new Map()
  const usedEntries = new Set()

  // 1-2-3-4. même compte : exact, fenêtre élargie, devise, tolérance.
  assign(bankTxns, own, sign, true, results, usedEntries)
  // 5. conversions de devise, avant les agrégats (une conversion ne doit pas
  // être reconstituée en additionnant des écritures sans rapport).
  assignConversions(bankTxns, own, sign, results, usedEntries)
  // 6. agrégats du même compte.
  assignAggregates(bankTxns, own, sign, results, usedEntries)
  assignReverseAggregates(bankTxns, own, sign, results, usedEntries)
  // 6. autres comptes mappés : le virement interne comptabilisé de l'autre côté.
  const others = index.all.filter((e) => e.accountId !== account.id)
  assign(bankTxns, others, sign, false, results, usedEntries)
  // Le signe s'inverse quand on regarde l'autre côté d'un virement.
  assign(bankTxns, others, -sign, false, results, usedEntries)

  const unmatchedQb = own.filter((e) => !usedEntries.has(e))
  const unmatchedBank = bankTxns.filter((t) => !results.has(t.id))
  return { matches: results, unmatchedBank, unmatchedQb, sign }
}

const defaultFetchTransfer = async (qbId) => (await qbGet(`/transfer/${qbId}`)).Transfer

// Vérifie une conversion contre l'objet Transfer de QuickBooks.
//
// Le rapport GeneralLedger affiche le montant en DEVISE DE TRANSACTION des deux
// côtés : un virement de 15 000 USD vers le compte CAD s'y lit « 15 000 » alors
// que le compte a bien reçu 20 992,50 CAD. Sans cette vérification, la
// différence ressemblait à un écart de 5 992,50 $ — un faux écart : QuickBooks
// porte le taux (`ExchangeRate`) sur la transaction, et montant × taux tombe au
// cent près sur la ligne de relevé. Une conversion vérifiée n'a donc AUCUN
// écart ; seule une conversion invérifiable en garde un.
export async function verifyConversions(matches, txnById, fetchTransfer = defaultFetchTransfer) {
  for (const [txnId, m] of matches) {
    if (m.method !== 'conversion') continue
    const e = m.entries[0]
    const txn = txnById.get(txnId)
    m.verified = false
    if (e.entity !== 'transfer' || !e.qbId || !txn) continue
    try {
      const tr = await fetchTransfer(e.qbId)
      const rate = Number(tr?.ExchangeRate || 0)
      const amount = Number(tr?.Amount || 0)
      if (!rate || !amount) continue
      // Le relevé peut être d'un côté ou de l'autre de la conversion.
      const converted = round2(amount * rate)
      if (Math.abs(converted - Math.abs(Number(txn.amount))) <= 0.02
        || Math.abs(amount - Math.abs(Number(txn.amount))) <= 0.02) {
        m.verified = true
        m.rate = Math.round(rate * 10000) / 10000
        m.delta = 0
      }
    } catch { /* QB indisponible : la conversion reste non vérifiée */ }
  }
  return matches
}

export function matchUrl(match) {
  const e = match?.entries?.[0]
  return e?.entity && e?.qbId ? qbEntityUrl(e.entity, e.qbId) : null
}

// Persiste le lien trouvé sur la transaction (mode `apply` de la sync).
const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
export function persistMatches(matches) {
  // La clause finale évite de réécrire (et de recompter) les liens déjà posés :
  // le compteur de la sync doit dire ce qui a CHANGÉ, pas ce qui existe.
  const update = db.prepare(`
    UPDATE bank_transactions
    SET qb_txn_type=?, qb_txn_id=?, qb_match_method=?, qb_match_delta=?, qb_match_account=?,
        qb_match_rate=?, updated_at=${NOW}
    WHERE id=? AND (qb_txn_id IS NOT ? OR qb_match_method IS NOT ?
                    OR qb_match_delta IS NOT ? OR qb_match_rate IS NOT ?)
  `)
  let n = 0
  const tx = db.transaction(() => {
    for (const [txnId, m] of matches) {
      const e = m.entries[0]
      if (!e?.qbId) continue
      const res = update.run(e.entity || null, e.qbId, m.method, m.delta || null,
        e.accountName && m.method === 'autre_compte' ? e.accountName : null, m.rate || null,
        txnId, e.qbId, m.method, m.delta || null, m.rate || null)
      n += res.changes
    }
  })
  tx()
  return n
}
