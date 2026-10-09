// Rapprochement « façon QuickBooks » : solde du compte calculé automatiquement
// à partir du relevé importé, comparé au solde QuickBooks à la même date, avec
// la liste exacte des transactions qui expliquent l'écart.
//
// Deux niveaux :
//   1. summarizeAccount()  — instantané, 100 % local (aucun appel QB) : solde du
//      relevé, solde calculé, ruptures de la chaîne des soldes, doublons.
//   2. compareWithQb()     — appelle QuickBooks : solde QB à la date du relevé,
//      écart, et l'appariement ligne à ligne relevé ↔ grand livre QB.
import db from '../db/database.js'
import { qbGet, qbEntityUrl } from '../connectors/quickbooks.js'
import { fetchQbLedgerRaw } from './bankQbLink.js'
import { searchAccount } from './bankQbSearch.js'
import { shiftDate } from '../utils/datetime.js'
import { round2 } from '../utils/money.js'


// Fenêtre d'anomalies remontées, en jours avant la date du relevé.
const ANOMALY_WINDOW_DAYS = 120

// ── Convention de solde du compte ────────────────────────────────────────────
//
// Deux inconnues varient d'un relevé à l'autre :
//   • le sens du solde — un compte de banque affiche l'argent disponible (solde
//     += montant), une carte affiche le solde DÛ (solde -= montant) ;
//   • l'ordre des lignes à l'intérieur d'une même journée — les relevés collés
//     listent tantôt le plus récent en premier, tantôt l'inverse, et la date
//     seule ne tranche pas.
// Plutôt que de les configurer, on les DÉDUIT : on essaie les 4 combinaisons et
// on garde celle qui produit le moins de ruptures dans la chaîne des soldes.

function orderRows(rows, intraDayDesc) {
  // `rows` arrive trié (txn_date, created_at) ASC : l'index d'origine sert de
  // rang d'insertion stable pour inverser l'ordre intra-journée.
  const rank = new Map(rows.map((r, i) => [r.id, i]))
  return [...rows].sort((a, b) => {
    if (a.txn_date !== b.txn_date) return a.txn_date < b.txn_date ? -1 : 1
    return intraDayDesc ? rank.get(b.id) - rank.get(a.id) : rank.get(a.id) - rank.get(b.id)
  })
}

// Parcourt la chaîne : chaque ligne portant un solde doit valoir le solde
// précédent plus les montants accumulés depuis. Les lignes sans solde (fréquent
// sur les relevés de carte) sont simplement accumulées.
function walkChain(rows, direction) {
  const breaks = []
  let anchor = null
  let anchorRow = null
  let acc = 0
  let checks = 0
  for (const r of rows) {
    acc = round2(acc + direction * r.amount)
    if (r.balance == null) continue
    if (anchor != null) {
      checks++
      const expected = round2(anchor + acc)
      const delta = round2(r.balance - expected)
      if (Math.abs(delta) > 0.005) {
        breaks.push({
          txn_id: r.id, date: r.txn_date, since: anchorRow?.txn_date || null,
          expected, actual: round2(r.balance), delta,
        })
      }
    }
    anchor = round2(r.balance)
    anchorRow = r
    acc = 0
  }
  return { breaks, checks, closing: anchor == null ? null : round2(anchor + acc), anchorRow }
}

export function detectConvention(rowsAsc) {
  let best = null
  for (const direction of [1, -1]) {
    for (const intraDayDesc of [false, true]) {
      const ordered = orderRows(rowsAsc, intraDayDesc)
      const res = walkChain(ordered, direction)
      const score = res.breaks.length
      if (!best || score < best.score
        || (score === best.score && res.checks > best.res.checks)) {
        best = { score, direction, intraDayDesc, res, ordered }
      }
    }
  }
  return best
}

// ── Résumé local d'un compte ─────────────────────────────────────────────────

function loadRows(accountId) {
  return db.prepare(`
    SELECT id, txn_date, description, details, reference, amount, balance, status,
           matched_id, matched_type, qb_txn_id, created_at
    FROM bank_transactions
    WHERE account_id=? AND deleted_at IS NULL
    ORDER BY txn_date ASC, created_at ASC
  `).all(accountId)
}

const txnLabel = (r) => r.details || r.description || '(sans description)'

// Doublons probables : même jour, même montant, même libellé et même référence.
// Deux achats identiques le même jour existent (l'import les accepte
// volontairement) — c'est donc un signalement, pas une erreur.
function findDuplicates(rows) {
  const groups = new Map()
  for (const r of rows) {
    if (r.status === 'ignore') continue
    const key = [r.txn_date, r.amount.toFixed(2), txnLabel(r).toLowerCase(), (r.reference || '').toLowerCase()].join('|')
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(r)
  }
  const out = []
  for (const list of groups.values()) {
    if (list.length < 2) continue
    out.push({
      txn_id: list[list.length - 1].id, date: list[0].txn_date,
      label: txnLabel(list[0]), amount: round2(list[0].amount), count: list.length,
    })
  }
  return out
}

export function summarizeAccount(accountId) {
  const account = db.prepare('SELECT * FROM bank_accounts WHERE id=? AND deleted_at IS NULL').get(accountId)
  if (!account) return null
  const rows = loadRows(accountId)
  const empty = {
    account_id: accountId, currency: account.currency, kind: account.kind,
    qb_account_id: account.qb_account_id || null,
    count: 0, statement: null, anomalies: [], totals: null,
  }
  if (!rows.length) return empty

  const conv = detectConvention(rows)
  const { res, ordered, direction } = conv
  // Dernière ligne portant un solde = fin du relevé ; les lignes postérieures
  // sans solde sont ajoutées pour obtenir le solde courant calculé.
  const lastWithBalance = [...ordered].reverse().find((r) => r.balance != null) || null
  const closing = res.closing
  // Vu comme un actif (négatif = argent dû), à l'image de QuickBooks : un solde
  // de carte « 161,51 $ dus » devient -161,51 $.
  const closingSigned = closing == null ? null : round2(direction * closing)

  const sum = (pred) => round2(rows.filter(pred).reduce((s, r) => s + r.amount, 0))
  const cnt = (pred) => rows.filter(pred).length

  // Les anomalies ne servent qu'à agir : on ne remonte que la période courante
  // (l'historique migré du xlsx traîne des soldes de carte recopiés à la main,
  // dont les ruptures ne sont plus corrigeables). Les plus vieilles sont
  // seulement comptées.
  const statementDate = lastWithBalance?.txn_date || ordered[ordered.length - 1].txn_date
  const since = shiftDate(statementDate, -ANOMALY_WINDOW_DAYS)
  const olderBreaks = res.breaks.filter((b) => b.date < since).length
  const olderDuplicates = findDuplicates(rows).filter((d) => d.date < since).length

  const anomalies = [
    ...res.breaks.filter((b) => b.date >= since).map((b) => ({
      kind: 'chaine_solde', severity: 'error', txn_id: b.txn_id, date: b.date, amount: b.delta,
      label: `Écart de ${b.delta.toFixed(2)} entre le solde du relevé et la somme des transactions`,
      explanation: b.since
        ? `Le solde passe de ${b.expected.toFixed(2)} attendu à ${b.actual.toFixed(2)} au relevé (depuis le ${b.since}) — une transaction manque probablement à l'import.`
        : `Solde attendu ${b.expected.toFixed(2)}, solde au relevé ${b.actual.toFixed(2)}.`,
    })),
    ...findDuplicates(rows).filter((d) => d.date >= since).map((d) => ({
      kind: 'doublon', severity: 'warn', txn_id: d.txn_id, date: d.date, amount: d.amount,
      label: `${d.count} lignes identiques — ${d.label}`,
      explanation: 'Même date, même montant, même libellé : vérifier s\'il s\'agit d\'un double import ou de deux vraies transactions.',
    })),
  ]

  return {
    ...empty,
    count: rows.length,
    convention: { direction, intra_day_desc: conv.intraDayDesc, checks: res.checks, breaks: res.breaks.length },
    period: { from: ordered[0].txn_date, to: ordered[ordered.length - 1].txn_date },
    statement: {
      balance: closing,
      balance_signed: closingSigned,
      date: statementDate,
      // Solde IMPRIMÉ à `date`. `balance` y ajoute les lignes postérieures sans
      // solde (solde courant) : le comparer à QuickBooks au `date` comptait ces
      // lignes comme un écart (MasterCard, 2026-09-26 : −6 472 $ fictifs).
      printed_balance_signed: res.anchorRow?.balance != null ? round2(direction * res.anchorRow.balance) : closingSigned,
      // Vrai si le solde de clôture vient d'une colonne « Solde » du relevé.
      from_statement: lastWithBalance != null,
    },
    totals: {
      in: sum((r) => r.amount > 0 && r.status !== 'ignore'),
      out: sum((r) => r.amount < 0 && r.status !== 'ignore'),
      reconciled_count: cnt((r) => r.status === 'rapproche'),
      pending_count: cnt((r) => r.status !== 'rapproche' && r.status !== 'ignore'),
      pending_total: sum((r) => r.status !== 'rapproche' && r.status !== 'ignore'),
      no_document_count: cnt((r) => r.status === 'a_traiter'),
      qb_linked_count: cnt((r) => r.qb_txn_id != null),
    },
    anomalies: anomalies.slice(0, 50),
    anomalies_since: since,
    anomalies_older_count: olderBreaks + olderDuplicates,
  }
}

// ── Comparaison avec QuickBooks ──────────────────────────────────────────────


// Le grand livre déborde la fenêtre du relevé : une écriture peut porter une
// date décalée de quelques jours par rapport au passage à la banque.
const LEDGER_MARGIN_DAYS = 35

// Un compte ERP peut couvrir plusieurs comptes QB (« 234,168 »), et le rapport
// GeneralLedger ne respecte pas toujours son filtre `account` : la même écriture
// revient alors une fois par appel. On fusionne en gardant, pour chaque écriture
// (id + date + montant), la multiplicité maximale vue sur un seul appel — ce qui
// préserve les vraies écritures à plusieurs lignes sans les compter en double.
function mergeLedgers(lists) {
  const keyOf = (e) => `${e.qbId || ''}|${e.date}|${e.amount}`
  const kept = new Map()
  for (const list of lists) {
    const local = new Map()
    for (const e of list) {
      const k = keyOf(e)
      if (!local.has(k)) local.set(k, [])
      local.get(k).push(e)
    }
    for (const [k, entries] of local) {
      if (!kept.has(k) || kept.get(k).length < entries.length) kept.set(k, entries)
    }
  }
  return [...kept.values()].flat()
}

async function qbCurrentBalance(qbAccountIds) {
  const ids = qbAccountIds.map((i) => `'${i}'`).join(',')
  const q = encodeURIComponent(`SELECT Id, Name, CurrentBalance, CurrencyRef FROM Account WHERE Id IN (${ids})`)
  const d = await qbGet(`/query?query=${q}`)
  const accounts = (d.QueryResponse?.Account || []).map((a) => ({
    id: String(a.Id), name: a.Name, balance: round2(Number(a.CurrentBalance || 0)), currency: a.CurrencyRef?.value || 'CAD',
  }))
  return { accounts, total: round2(accounts.reduce((s, a) => s + a.balance, 0)) }
}

// Solde QB tel qu'il était à `asOf` : le solde courant moins tout ce qui a été
// enregistré après cette date (QuickBooks ne fournit pas de solde daté).
export async function qbBalanceAsOf(qbAccountIds, asOf) {
  const { accounts, total } = await qbCurrentBalance(qbAccountIds)
  const today = new Date().toISOString().slice(0, 10)
  const start = shiftDate(asOf, 1)
  // Le relevé peut porter des dates futures : rien à retrancher dans ce cas.
  const end = shiftDate(today > asOf ? today : asOf, 400)
  if (start > end) return { accounts, current: total, as_of: total, after: 0 }
  const lists = []
  for (const id of qbAccountIds) {
    const cur = accounts.find((a) => a.id === String(id))?.currency || 'CAD'
    lists.push(await fetchQbLedgerRaw(id, start, end, { inAccountCurrency: cur !== 'CAD' }))
  }
  const after = round2(mergeLedgers(lists).reduce((s, e) => s + e.amount, 0))
  return { accounts, current: total, as_of: round2(total - after), after }
}

// Apparie relevé ↔ grand livre QB sur une période et retourne ce qui reste
// orphelin de chaque côté : c'est la décomposition exacte de l'écart.
//
// L'appariement n'est PAS refait ici. Il y avait jusqu'au 2026-09-19 un second
// moteur maison (montant exact, ±4 jours, aucune tolérance) dont le verdict
// peignait le drapeau « aucune écriture correspondante » et les lignes
// fantômes de la page Rapprochement — plus pauvre que celui qui pose les
// liens, il contredisait donc l'état affiché sur la même ligne : les frais
// mensuels de 8 $ US de juin et juillet et les paiements de la Visa USD
// étaient liés à leur écriture ET signalés absents. Un seul juge désormais :
// searchAccount(), celui de bankQbVerify.
export async function compareWithQb(accountId, opts = {}) {
  const account = db.prepare('SELECT * FROM bank_accounts WHERE id=? AND deleted_at IS NULL').get(accountId)
  if (!account) throw new Error('Compte introuvable')
  if (!account.qb_account_id) throw new Error('Aucun compte QuickBooks mappé pour ce compte')
  const summary = summarizeAccount(accountId)
  if (!summary?.count) throw new Error('Aucune transaction importée pour ce compte')

  const qbIds = String(account.qb_account_id).split(',').map((s) => s.trim()).filter(Boolean)
  const to = opts.to || summary.period.to
  const from = opts.from || (() => {
    const d = new Date(`${to}T12:00:00Z`)
    d.setUTCDate(d.getUTCDate() - 90)
    const iso = d.toISOString().slice(0, 10)
    return iso > summary.period.from ? iso : summary.period.from
  })()

  // Mêmes colonnes que le moteur de vérification : searchAccount lit le
  // libellé (affinité) et la couleur déclarée.
  const txns = db.prepare(`
    SELECT id, txn_date, COALESCE(NULLIF(details,''), description) AS description, details, reference,
           amount, status, matched_id, matched_type, sheet_color, qb_txn_id, qb_match_method, transfer_txn_id
    FROM bank_transactions
    WHERE account_id=? AND deleted_at IS NULL AND status != 'ignore'
      AND COALESCE(pending, 0) = 0 AND txn_date BETWEEN ? AND ?
    ORDER BY txn_date
  `).all(accountId, from, to)

  // L'écart passe par l'index PARTAGÉ du rapprochement (cache 5 min, invalidé
  // dès qu'on écrit dans QuickBooks) : ouvrir un compte ne relance plus douze
  // rapports de grand livre.
  const { getSharedLedgerIndex, qbVerifyConfig } = await import('./bankQbVerify.js')
  const index = await getSharedLedgerIndex(shiftDate(from, -LEDGER_MARGIN_DAYS), shiftDate(to, LEDGER_MARGIN_DAYS))
  const ledger = index.byAccount.get(accountId) || []

  const { matches, unmatchedBank, unmatchedQb } = txns.length
    ? searchAccount(account, txns, index)
    : { matches: new Map(), unmatchedBank: [], unmatchedQb: ledger }

  // Montant en devise du compte quand QuickBooks le fournit : le relevé, lui,
  // est toujours en devise du compte.
  const shown = (e) => (e.foreign != null ? e.foreign : e.amount)

  // Garde-fous repris de bankQbVerify : une ligne trop fraîche n'est pas un
  // écart (délai normal de saisie), une écriture antérieure au premier relevé
  // du compte n'a rien à quoi être appariée, et une écriture non compensée est
  // saisie dans QuickBooks mais jamais passée à la banque.
  const graceDays = Number(qbVerifyConfig().grace_days) || 4
  const cutoff = shiftDate(new Date().toISOString().slice(0, 10), -graceDays)
  const firstStatementDate = db.prepare(`
    SELECT MIN(txn_date) AS d FROM bank_transactions
    WHERE account_id=? AND deleted_at IS NULL
  `).get(accountId)?.d || from

  const missingInQb = unmatchedBank.filter((t) => t.txn_date <= cutoff).map((t) => ({
    txn_id: t.id, date: t.txn_date, label: t.details || t.description || '(sans description)',
    amount: round2(t.amount), status: t.status,
  }))
  const missingInStatement = unmatchedQb.filter((e) => (
    e.date >= from && e.date <= to && e.date >= firstStatementDate
    && (e.cleared === 'C' || e.cleared === 'R')
  )).map((e) => ({
    date: e.date, entity: e.entity, qb_id: e.qbId, amount: shown(e),
    label: e.name || e.type || null,
    url: e.entity && e.qbId ? qbEntityUrl(e.entity, e.qbId) : null,
  }))

  const inPeriod = (e) => e.date >= from && e.date <= to
  const statementMovement = round2(txns.reduce((s, t) => s + t.amount, 0))
  const qbMovement = round2(ledger.filter(inPeriod).reduce((s, e) => s + shown(e), 0))

  let balance = null
  try {
    const b = await qbBalanceAsOf(qbIds, summary.statement.date)
    balance = {
      qb_accounts: b.accounts, qb_current: b.current, qb_as_of: b.as_of,
      statement: summary.statement.printed_balance_signed, statement_date: summary.statement.date,
      difference: summary.statement.printed_balance_signed == null ? null : round2(summary.statement.printed_balance_signed - b.as_of),
    }
  } catch (e) {
    balance = { error: e.message }
  }

  return {
    period: { from, to },
    balance,
    movement: {
      statement: statementMovement, qb: qbMovement,
      difference: round2(statementMovement - qbMovement),
    },
    matched: matches.size,
    scanned: txns.length,
    ledger_entries: ledger.length,
    missing_in_qb: missingInQb,
    missing_in_statement: missingInStatement,
  }
}
