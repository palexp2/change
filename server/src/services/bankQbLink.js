// Liaison des transactions bancaires aux transactions QuickBooks.
//
// Le rapprochement classique (bankReconciliation.js) apparie une ligne de
// relevé à un document ERP (achat, reçu, payout). Mais l'historique importé du
// xlsx est « rapproché » sans document — et l'utilisateur veut quand même
// pouvoir ouvrir la transaction QB correspondante. On interroge donc le
// rapport GeneralLedger de QB filtré sur le compte bancaire mappé
// (bank_accounts.qb_account_id, possiblement plusieurs ids séparés par
// virgule) et on apparie par montant exact + date la plus proche (±4 jours).
import db from '../db/database.js'
import { qbGet, qbEntityUrl } from '../connectors/quickbooks.js'
import { shiftDate, daysBetween as dayDiff } from '../utils/datetime.js'

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`

// Libellés (localisés FR) du rapport GL → entité des URLs /app/<entity>?txnId=.
// Un type absent de la table n'est pas liable (pas d'URL fiable) — on l'ignore.
export const TXN_TYPE_ENTITY = {
  'Dépense': 'expense',
  'Expense': 'expense',
  'Chèque': 'check',
  'Cheque': 'check',
  'Check': 'check',
  'Dépense de chèque': 'check',
  'Dépôt': 'deposit',
  'Deposit': 'deposit',
  'Virement': 'transfer',
  'Transfer': 'transfer',
  'Écriture de journal': 'journal',
  'Journal Entry': 'journal',
  'Paiement de factures (chèque)': 'billpayment',
  'Paiement de factures (carte de crédit)': 'billpayment',
  'Bill Payment (Check)': 'billpayment',
  'Bill Payment (Credit Card)': 'billpayment',
  'Paiement': 'recvpayment',
  'Payment': 'recvpayment',
  'Reçu de vente': 'salesreceipt',
  'Sales Receipt': 'salesreceipt',
  'Crédit sur carte de crédit': 'creditcardcredit',
  'Credit Card Credit': 'creditcardcredit',
  'Remboursement': 'refundreceipt',
  'Refund': 'refundreceipt',
  'Paiement par carte de crédit': 'creditcardpayment',
  'Credit Card Payment': 'creditcardpayment',
  'Paiement de la taxe de vente': 'salestaxpayment',
  'Sales Tax Payment': 'salestaxpayment',
}

// Aplati les Rows imbriquées (sections/sous-totaux) du rapport GL.
function walkRows(rows, out) {
  for (const r of rows || []) {
    if (r.Rows?.Row) walkRows(r.Rows.Row, out)
    if (r.ColData) out.push(r.ColData)
  }
  return out
}

// Liste des comptes Banque / Carte de crédit côté QB (pour l'UI de mapping).
export async function listQbBankAccounts() {
  const q = encodeURIComponent(
    `SELECT Id, Name, AcctNum, AccountType, CurrencyRef FROM Account WHERE AccountType IN ('Bank','Credit Card') MAXRESULTS 200`
  )
  const data = await qbGet(`/query?query=${q}`)
  return (data.QueryResponse?.Account || []).map((a) => ({
    id: String(a.Id),
    name: a.Name,
    acctnum: a.AcctNum || null,
    type: a.AccountType,
    currency: a.CurrencyRef?.value || null,
  }))
}

// Entrées du grand livre QB d'un compte : [{ date, entity, id, amount }]
// amount signé comme les relevés ERP : négatif = sortie d'argent.
// Pour un compte d'actif (banque) : débit = entrée. Pour une carte de crédit
// (passif) : crédit = achat (sortie d'argent), débit = paiement/remboursement.
// Dans les deux cas la ligne de relevé suit l'argent, donc :
//   banque : amount = débit - crédit · carte : amount = débit - crédit aussi
// (un achat carte est un crédit QB et une ligne négative au relevé).
export async function fetchQbLedger(qbAccountId, startDate, endDate) {
  const cols = 'tx_date,txn_type,debt_amt,credit_amt,nat_foreign_amount'
  const d = await qbGet(
    `/reports/GeneralLedger?start_date=${startDate}&end_date=${endDate}&account=${qbAccountId}&columns=${cols}`
  )
  const colKeys = (d.Columns?.Column || []).map((c) => c.MetaData?.find((m) => m.Name === 'ColKey')?.Value)
  const idx = (k) => colKeys.indexOf(k)
  const [iDate, iType, iDebit, iCredit, iForeign] =
    ['tx_date', 'txn_type', 'debt_amt', 'credit_amt', 'nat_foreign_amount'].map(idx)
  const entries = []
  for (const cols of walkRows(d.Rows?.Row, [])) {
    const date = cols[iDate]?.value || ''
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue // "Solde initial", totaux…
    const typeCol = cols[iType]
    const entity = TXN_TYPE_ENTITY[typeCol?.value]
    const qbId = typeCol?.id
    if (!entity || !qbId) continue
    const debit = Number(cols[iDebit]?.value || 0)
    const credit = Number(cols[iCredit]?.value || 0)
    let amount = debit - credit
    // Compte en devise étrangère : le relevé est en devise du compte, le GL en
    // devise maison — on préfère le montant étranger quand il est fourni.
    const foreign = iForeign >= 0 ? Number(cols[iForeign]?.value || 0) : 0
    if (foreign) amount = Math.sign(amount || foreign) * Math.abs(foreign)
    if (!amount) continue
    entries.push({ date, entity, qbId: String(qbId), amount: Math.round(amount * 100) / 100 })
  }
  return entries
}

// Même rapport, mais SANS filtrer sur les types liables : pour recalculer un
// solde il faut la totalité des mouvements, y compris ceux qu'on ne sait pas
// transformer en URL (transferts de taxe, ajustements…).
export async function fetchQbLedgerRaw(qbAccountId, startDate, endDate) {
  const cols = 'tx_date,txn_type,debt_amt,credit_amt,nat_foreign_amount'
  const d = await qbGet(
    `/reports/GeneralLedger?start_date=${startDate}&end_date=${endDate}&account=${qbAccountId}&columns=${cols}`
  )
  const colKeys = (d.Columns?.Column || []).map((c) => c.MetaData?.find((m) => m.Name === 'ColKey')?.Value)
  const idx = (k) => colKeys.indexOf(k)
  const [iDate, iType, iDebit, iCredit, iForeign] =
    ['tx_date', 'txn_type', 'debt_amt', 'credit_amt', 'nat_foreign_amount'].map(idx)
  const entries = []
  for (const cols2 of walkRows(d.Rows?.Row, [])) {
    const date = cols2[iDate]?.value || ''
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue // "Solde initial", totaux…
    const debit = Number(cols2[iDebit]?.value || 0)
    const credit = Number(cols2[iCredit]?.value || 0)
    let amount = debit - credit
    const foreign = iForeign >= 0 ? Number(cols2[iForeign]?.value || 0) : 0
    if (foreign) amount = Math.sign(amount || foreign) * Math.abs(foreign)
    if (!amount) continue
    entries.push({ date, qbId: String(cols2[iType]?.id || ''), amount: Math.round(amount * 100) / 100 })
  }
  return entries
}

// Même rapport, enrichi du NOM (tiers) et du marqueur de compensation
// `is_cleared`, et filtré sur les seules écritures que QuickBooks dit passées à
// la banque :
//   « C » = compensée (appariée au flux bancaire) · « R » = rapprochée.
// Une valeur vide signifie « saisie dans QB, jamais vue à la banque » — c'est
// précisément ce qu'il ne faut PAS considérer comme passé (chèque non encaissé,
// paiement post-daté). Sert à cocher « passé à la banque » sur les paiements
// émis (services/treasuryQbClear.js).
// Le type d'écriture est conservé tel quel (localisé FR) pour l'affichage, et
// traduit en entité d'URL quand c'est possible.
export async function fetchQbLedgerCleared(qbAccountIds, startDate, endDate) {
  const cols = 'tx_date,txn_type,name,memo,doc_num,debt_amt,credit_amt,is_cleared'
  const lists = []
  // Un compte ERP peut couvrir plusieurs comptes QB (ids séparés par virgule) —
  // et QB renvoie parfois les MÊMES écritures aux deux appels : on fusionne par
  // multiplicité maximale, comme mergeLedgers() du résumé de rapprochement.
  for (const qbId of String(qbAccountIds).split(',').map(s => s.trim()).filter(Boolean)) {
    const d = await qbGet(
      `/reports/GeneralLedger?start_date=${startDate}&end_date=${endDate}&account=${qbId}&columns=${cols}`
    )
    const colKeys = (d.Columns?.Column || []).map((c) => c.MetaData?.find((m) => m.Name === 'ColKey')?.Value)
    const idx = (k) => colKeys.indexOf(k)
    const [iDate, iType, iName, iMemo, iDoc, iDebit, iCredit, iCleared] =
      ['tx_date', 'txn_type', 'name', 'memo', 'doc_num', 'debt_amt', 'credit_amt', 'is_cleared'].map(idx)
    const list = []
    for (const cols2 of walkRows(d.Rows?.Row, [])) {
      const date = cols2[iDate]?.value || ''
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue // « Solde initial », totaux…
      const cleared = String(cols2[iCleared]?.value || '').trim().toUpperCase()
      if (cleared !== 'C' && cleared !== 'R') continue
      const debit = Number(cols2[iDebit]?.value || 0)
      const credit = Number(cols2[iCredit]?.value || 0)
      const amount = Math.round((debit - credit) * 100) / 100
      if (!amount) continue
      const typeCol = cols2[iType]
      list.push({
        date, amount, cleared,
        type: typeCol?.value || null,
        entity: TXN_TYPE_ENTITY[typeCol?.value] || null,
        qbId: typeCol?.id ? String(typeCol.id) : null,
        name: cols2[iName]?.value || null,
        memo: iMemo >= 0 ? (cols2[iMemo]?.value || null) : null,
        doc_num: iDoc >= 0 ? (cols2[iDoc]?.value || null) : null,
      })
    }
    lists.push(list)
  }
  if (lists.length <= 1) return lists[0] || []
  const keyOf = e => `${e.qbId || ''}|${e.date}|${e.amount}`
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

const MAX_DAY_GAP = 4

// Apparie les transactions non liées d'un compte ERP à leur transaction QB.
// Montant exact (même signe) + date la plus proche ≤ 4 jours ; chaque entrée QB
// ne sert qu'une fois. Retourne { scanned, linked, ledgerEntries }.
export async function linkAccountToQb(accountId) {
  const account = db.prepare('SELECT * FROM bank_accounts WHERE id=? AND deleted_at IS NULL').get(accountId)
  if (!account) throw new Error('Compte introuvable')
  if (!account.qb_account_id) throw new Error('Aucun compte QuickBooks mappé (qb_account_id)')

  const txns = db.prepare(`
    SELECT id, txn_date, amount FROM bank_transactions
    WHERE account_id=? AND deleted_at IS NULL AND qb_txn_id IS NULL AND status != 'ignore'
    ORDER BY txn_date
  `).all(accountId)
  if (!txns.length) return { scanned: 0, linked: 0, ledgerEntries: 0 }

  const start = shiftDate(txns[0].txn_date, -MAX_DAY_GAP)
  const end = shiftDate(txns[txns.length - 1].txn_date, MAX_DAY_GAP)

  // Un compte ERP peut couvrir plusieurs comptes QB (ids séparés par virgule).
  const ledger = []
  for (const qbId of String(account.qb_account_id).split(',').map((s) => s.trim()).filter(Boolean)) {
    ledger.push(...await fetchQbLedger(qbId, start, end))
  }

  // Index par montant signé exact → liste d'entrées consommables.
  const byAmount = new Map()
  for (const e of ledger) {
    const key = e.amount.toFixed(2)
    if (!byAmount.has(key)) byAmount.set(key, [])
    byAmount.get(key).push(e)
  }

  // L'orientation des signes varie selon le compte : sur un compte d'actif le
  // relevé suit le GL (sortie = crédit = négatif), mais sur un passif (marge,
  // carte selon l'émetteur) le relevé peut noter une avance en positif là où
  // le GL la crédite. On essaie ±1 et on garde l'orientation qui matche le plus.
  const matchAll = (sign) => {
    const used = new Set()
    const matches = []
    for (const t of txns) {
      const pool = byAmount.get((sign * Number(t.amount)).toFixed(2))
      if (!pool?.length) continue
      let best = null
      let bestDiff = Infinity
      for (const e of pool) {
        if (used.has(e)) continue
        const diff = dayDiff(t.txn_date, e.date)
        if (diff <= MAX_DAY_GAP && diff < bestDiff) { best = e; bestDiff = diff }
      }
      if (!best) continue
      used.add(best)
      matches.push([t, best])
    }
    return matches
  }
  const plus = matchAll(1)
  const minus = matchAll(-1)
  const matches = plus.length >= minus.length ? plus : minus

  const update = db.prepare(`UPDATE bank_transactions SET qb_txn_type=?, qb_txn_id=?, updated_at=${NOW} WHERE id=?`)
  const tx = db.transaction(() => {
    for (const [t, e] of matches) update.run(e.entity, e.qbId, t.id)
  })
  tx()
  return { scanned: txns.length, linked: matches.length, ledgerEntries: ledger.length }
}

export function storedQbUrl(txn) {
  return txn.qb_txn_id && txn.qb_txn_type ? qbEntityUrl(txn.qb_txn_type, txn.qb_txn_id) : null
}
