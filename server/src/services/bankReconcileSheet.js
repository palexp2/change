// Feuille de rapprochement d'un compte, mois par mois (Charles, 2026-10-06) :
// le relevé à gauche, QuickBooks à droite, ligne contre ligne. L'appariement
// n'est pas refait ici : c'est celui de searchAccount(), le même juge que la
// page Transactions et la vérification QB.
import db from '../db/database.js'
import { qbEntityUrl, onQbMutation, qbGet } from '../connectors/quickbooks.js'
import { searchAccount } from './bankQbSearch.js'
import { detectConvention, qbBalanceAsOf, summarizeAccount } from './bankReconcileSummary.js'
import { shiftDate } from '../utils/datetime.js'
import { round2 } from '../utils/money.js'

const MONTHS_SHOWN = 6
const ZERO = 0.005

// Solde QB à une date : deux appels Intuit (~0,5 s) à chaque changement de
// mois ou de compte. Mémorisé 5 min, vidé dès qu'on écrit dans QuickBooks
// (Charles, 2026-10-06 : « à peu près instantané »).
const BAL_TTL_MS = 5 * 60 * 1000
const balCache = new Map()
onQbMutation(() => balCache.clear())
function cachedQbBalance(qbId, date) {
  const key = `${qbId}|${date}`
  const hit = balCache.get(key)
  if (hit && Date.now() - hit.at < BAL_TTL_MS) return hit.promise
  const promise = qbBalanceAsOf([qbId], date).catch((e) => { balCache.delete(key); throw e })
  balCache.set(key, { at: Date.now(), promise })
  return promise
}

const monthOf = (d) => String(d).slice(0, 7)
const lastDay = (ym) => {
  const [y, m] = ym.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
}
const prevMonth = (ym, n = 1) => {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 - n, 1))
  return d.toISOString().slice(0, 7)
}

// Compte QB de type carte de crédit (la marge Desjardins en est une) : la
// dette se compare en négatif. Lu une fois par compte.
const liabilityCache = new Map()
export function isQbLiability(qbId) {
  if (!liabilityCache.has(qbId)) {
    liabilityCache.set(qbId, qbGet(`/account/${qbId}`)
      .then((d) => /credit card|liability/i.test(d?.Account?.AccountType || ''))
      .catch(() => { liabilityCache.delete(qbId); return false }))
  }
  return liabilityCache.get(qbId)
}

// Solde du relevé au soir de `date`, vu comme un actif (comme QuickBooks).
// Trois pièges vécus (Charles, 2026-10-06, tour de tous les comptes) :
//  • plusieurs soldes imprimés le même jour : celui du soir est celui qu'aucune
//    autre ligne du jour n'a pour solde « avant » (BNC CAD, août : −23 654 $) ;
//  • un solde imprimé qui ne prolonge pas le précédent (carte : retenues en
//    attente comptées à l'export) n'est pas une ancre — on garde la dernière
//    ancre saine et on additionne les lignes, retenues ignorées exclues
//    (MasterCard, septembre : −1 881 $) ;
//  • une marge de crédit imprime sa dette en positif : passif → solde négatif
//    comme QuickBooks (Marge Desjardins : écart du double de la dette).
function bankBalanceAt(accountId, date, { liability = false } = {}) {
  const rows = db.prepare(`
    SELECT id, txn_date, amount, balance, status FROM bank_transactions
    WHERE account_id=? AND deleted_at IS NULL ORDER BY txn_date ASC, created_at ASC
  `).all(accountId)
  if (!rows.length) return null
  const { direction, ordered } = detectConvention(rows)
  const days = new Map()
  for (const r of ordered) {
    if (r.txn_date > date) break
    if (!days.has(r.txn_date)) days.set(r.txn_date, [])
    days.get(r.txn_date).push(r)
  }
  let anchor = null // dernier solde imprimé sain
  let printed = null // dernier solde imprimé, sain ou non
  let accAll = 0 // depuis `printed`, toutes lignes
  let accKept = 0 // depuis `anchor`, sans les lignes ignorées
  for (const list of days.values()) {
    const sum = (pick) => round2(list.reduce((n, r) => n + (pick(r) ? direction * r.amount : 0), 0))
    const withBal = list.filter((r) => r.balance != null)
    if (!withBal.length) {
      accAll = round2(accAll + sum(() => true))
      accKept = round2(accKept + sum((r) => r.status !== 'ignore'))
      continue
    }
    const before = new Set(withBal.map((r) => round2(r.balance - direction * r.amount).toFixed(2)))
    const evening = withBal.filter((r) => !before.has(round2(r.balance).toFixed(2)))
    const last = evening.length === 1 ? evening[0] : withBal[withBal.length - 1]
    const bal = round2(last.balance)
    const sound = printed == null || Math.abs(round2(printed + accAll + sum(() => true)) - bal) < 0.01
    if (sound) { anchor = bal; accKept = 0 } else accKept = round2(accKept + sum((r) => r.status !== 'ignore'))
    printed = bal
    accAll = 0
  }
  if (anchor == null) return null
  const value = round2(anchor + accKept)
  // Les relevés de passif impriment la dette en positif.
  return liability ? round2(-Math.abs(direction) * value) : round2(direction * value)
}

const entryLabel = (e) => e.name || e.memo || e.type || null

// Les cas bizarres d'un mois, marqués d'une pastille (Charles, 2026-10-06, S3) :
// plusieurs débits du relevé pour UNE écriture QuickBooks (Mouser 3 → 1), ou un
// aller-retour du même marchand qui s'annule sans écriture (FedEx +2,40/−2,40).
// Appariement au marchand (premier mot) et à la date, jamais au libellé entier.
const GROUP_IDS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const daysApart = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 864e5
// Marchand = premier mot de lettres : « FEDEX272708328 » et « -FEDEX- CANADA »
// donnent tous deux « fedex ».
export const merchantKey = (label) => (String(label || '').toLowerCase().match(/[a-z]{3,}/) || [''])[0]
export function linkGroups(rows) {
  const groups = []
  const loose = rows.filter((r) => r.bank && !r.qb)
  const used = new Set()
  const tag = (members, info) => {
    const id = GROUP_IDS[groups.length % GROUP_IDS.length]
    for (const r of members) { r.group = id; used.add(r) }
    groups.push({ id, ...info })
  }
  // Aller-retour : un débit et son remboursement, même marchand, sans écriture.
  for (const a of loose) {
    if (used.has(a)) continue
    const b = loose.find((x) => x !== a && !used.has(x) && Math.abs(x.bank.amount + a.bank.amount) < 0.005
      && merchantKey(x.bank.label) === merchantKey(a.bank.label) && daysApart(x.bank.date, a.bank.date) <= 15)
    if (b) tag([a, b], { kind: 'retour', count: 2 })
  }
  // Remboursement sans écriture : le débit, lui, est passé dans QuickBooks.
  for (const a of loose) {
    if (used.has(a) || !(a.bank.amount > 0)) continue
    const b = rows.find((x) => x !== a && x.bank && x.qb && !used.has(x) && Math.abs(x.bank.amount + a.bank.amount) < 0.005
      && merchantKey(x.bank.label) === merchantKey(a.bank.label) && daysApart(x.bank.date, a.bank.date) <= 15)
    if (b) tag([a, b], { kind: 'rembourse', count: 2 })
  }
  // Plusieurs lignes du relevé pour une écriture QuickBooks restée seule.
  for (const q of rows.filter((r) => r.qb && !r.bank)) {
    const key = merchantKey(q.qb.label)
    if (!key) continue
    const mates = loose.filter((r) => !used.has(r) && merchantKey(r.bank.label) === key
      && Math.sign(r.bank.amount) === Math.sign(q.qb.amount) && daysApart(r.bank.date, q.qb.date) <= 20)
    if (!mates.length) continue
    const bankTotal = round2(mates.reduce((n, r) => n + r.bank.amount, 0))
    tag([...mates, q], { kind: 'regroupe', count: mates.length, bank_total: bankTotal, qb_total: q.qb.amount, gap: round2(bankTotal - q.qb.amount) })
  }
  return groups
}

/**
 * @param {string} accountId
 * @param {string} [month]  'YYYY-MM' ; défaut : mois du dernier relevé
 */
export async function reconcileSheet(accountId, month) {
  const account = db.prepare('SELECT * FROM bank_accounts WHERE id=? AND deleted_at IS NULL').get(accountId)
  if (!account) throw new Error('Compte introuvable')
  if (!account.qb_account_id) throw new Error('Aucun compte QuickBooks mappé pour ce compte')
  const summary = summarizeAccount(accountId)
  if (!summary?.count) throw new Error('Aucune transaction importée pour ce compte')

  // Avant que le relevé n'arrive (MasterCard : vers le 15 du mois suivant), la
  // gauche montre ce que la page Transactions a déjà reçu (Charles,
  // 2026-10-06). Le relevé imprimé ne fait que fixer le solde.
  const statementDate = summary.statement.date
  const latest = db.prepare(`
    SELECT MAX(txn_date) AS d FROM bank_transactions
    WHERE account_id=? AND deleted_at IS NULL AND COALESCE(pending, 0) = 0
  `).get(accountId)?.d
  const to = latest && latest > statementDate ? latest : statementDate
  const lastMonth = monthOf(to)
  const months = Array.from({ length: MONTHS_SHOWN }, (_, i) => prevMonth(lastMonth, MONTHS_SHOWN - 1 - i))
  const from = `${months[0]}-01`

  const txns = db.prepare(`
    SELECT id, txn_date, COALESCE(NULLIF(details,''), description) AS description, details, reference,
           amount, status, matched_id, matched_type, sheet_color, qb_txn_id, qb_match_method, transfer_txn_id,
           group_parent_id, (SELECT COUNT(*) FROM bank_transactions g WHERE g.group_parent_id = bank_transactions.id) AS group_count
    FROM bank_transactions
    WHERE account_id=? AND deleted_at IS NULL AND status != 'ignore'
      AND COALESCE(pending, 0) = 0 AND txn_date BETWEEN ? AND ?
    ORDER BY txn_date
  `).all(accountId, from, to)

  const { getSharedLedgerIndex, qbVerifyConfig } = await import('./bankQbVerify.js')
  const index = await getSharedLedgerIndex(shiftDate(from, -35), shiftDate(to, 35))
  // Seul le compte QB principal se rapproche (Charles, 2026-10-06 : BNC USD =
  // 10021 seulement ; 10020, le parent, porte l'ajustement de change de fin de
  // mois et ne compte pas). Les autres ids servent encore à apparier.
  const mainId = String(account.qb_account_id).split(',').map((x) => x.trim()).find(Boolean)
  const isMain = (e) => !e.qbAccountId || e.qbAccountId === mainId
  const own = (index.byAccount.get(accountId) || []).filter(isMain)
  const { matches, unmatchedBank, unmatchedQb, sign } = txns.length
    ? searchAccount(account, txns, index)
    : { matches: new Map(), unmatchedBank: [], unmatchedQb: own, sign: 1 }
  const s = sign || 1
  const shown = (e) => round2(s * (e.foreign != null ? e.foreign : e.amount))

  const graceDays = Number(qbVerifyConfig().grace_days) || 4
  const cutoff = shiftDate(new Date().toISOString().slice(0, 10), -graceDays)
  const unmatchedIds = new Set(unmatchedBank.map((t) => t.id))

  const rows = []
  for (const t of txns) {
    const m = matches.get(t.id)
    const bank = { id: t.id, date: t.txn_date, label: t.description || '(sans description)', amount: round2(t.amount) }
    // Ligne regroupée (« Dégrouper ») ou ligne d'un groupe défait (« Regrouper »).
    if (t.group_count) bank.group_count = t.group_count
    else if (t.group_parent_id) bank.group_parent_id = t.group_parent_id
    if (m) {
      const e = m.entries[0]
      rows.push({
        kind: 'ok', month: monthOf(t.txn_date), bank,
        qb: {
          date: e.date, label: entryLabel(e) + (m.entries.length > 1 ? ` +${m.entries.length - 1}` : ''),
          amount: round2(m.entries.reduce((sum, x) => sum + shown(x), 0)),
          url: e.entity && e.qbId ? qbEntityUrl(e.entity, e.qbId) : null,
          entity: e.entity || null, qb_id: e.qbId || null, count: m.entries.length,
          other_account: e.accountId && e.accountId !== accountId ? e.accountName : null,
          cleared: m.entries.every((x) => x.cleared === 'R') ? 'R' : m.entries.every((x) => x.cleared) ? 'C' : null,
        },
        shifted: monthOf(e.date) !== monthOf(t.txn_date),
      })
    } else if (unmatchedIds.has(t.id)) {
      // Validée à la main sans écriture retrouvée : on la tient pour faite.
      const kind = t.status === 'rapproche' ? 'ok' : t.txn_date > cutoff ? 'fresh' : 'bank'
      rows.push({ kind, month: monthOf(t.txn_date), bank, qb: null })
    }
  }
  const firstDate = txns[0]?.txn_date || from
  for (const e of unmatchedQb) {
    if (!isMain(e)) continue
    if (e.date < from || e.date > lastDay(lastMonth) || e.date < firstDate) continue
    rows.push({
      kind: e.cleared === 'C' || e.cleared === 'R' ? 'qb' : 'wait', month: monthOf(e.date), bank: null,
      qb: { date: e.date, label: entryLabel(e), amount: shown(e), url: e.entity && e.qbId ? qbEntityUrl(e.entity, e.qbId) : null, cleared: e.cleared },
    })
  }
  const dateOf = (r) => r.bank?.date || r.qb?.date
  rows.sort((a, b) => (dateOf(a) < dateOf(b) ? 1 : dateOf(a) > dateOf(b) ? -1 : 0))

  // Un mois est fermé quand toutes ses écritures QB du compte sont « R ».
  const monthList = months.map((ym) => {
    const mine = rows.filter((r) => r.month === ym)
    const entries = own.filter((e) => monthOf(e.date) === ym)
    const todo = mine.filter((r) => r.kind === 'bank' || r.kind === 'qb').length
    const closed = entries.length > 0 && entries.every((e) => e.cleared === 'R') && todo === 0
    return { month: ym, todo, closed, open: ym === lastMonth && to < lastDay(ym), provisional: statementDate < lastDay(ym) }
  })

  // Défaut : le plus vieux mois pas encore fermé.
  const sel = months.includes(month) ? month : (monthList.find((m) => !m.closed)?.month || lastMonth)
  const end = sel === lastMonth ? to : lastDay(sel)
  const bankBal = bankBalanceAt(accountId, end, { liability: account.kind === 'card' || await isQbLiability(mainId) })
  let qbBal = null
  let qbError = null
  try {
    qbBal = (await cachedQbBalance(mainId, end)).as_of
  } catch (e) { qbError = e.message }
  // En transit : appariées de part et d'autre de la fin du mois (débit du 1er
  // pour une écriture du 30, virement parti le 29 et reçu le 1er). Écart de
  // calendrier, pas d'erreur : on le soustrait (Charles, 2026-10-06 : MasterCard
  // juin–juillet, Google, à rapprocher à 0 sans toucher QuickBooks).
  let inTransit = 0
  for (const t of txns) {
    for (const e of matches.get(t.id)?.entries || []) {
      if (t.txn_date <= end && e.date > end) inTransit += shown(e)
      else if (e.date <= end && t.txn_date > end) inTransit -= shown(e)
    }
  }
  inTransit = round2(inTransit)
  const difference = bankBal != null && qbBal != null ? round2(bankBal - qbBal - inTransit) : null
  const shownRows = rows.filter((r) => r.month === sel)
  const groups = linkGroups(shownRows)

  return {
    account: { id: account.id, name: account.name, currency: account.currency },
    month: sel,
    end,
    // Mois pas encore couvert par un relevé : la gauche = les transactions reçues.
    provisional: statementDate < end,
    bank_balance: bankBal,
    qb_balance: qbBal,
    qb_error: qbError,
    in_transit: inTransit,
    difference,
    balanced: difference != null && Math.abs(difference) < ZERO,
    months: monthList,
    rows: shownRows,
    groups,
  }
}
