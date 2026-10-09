// Liaison des transactions bancaires aux transactions QuickBooks.
//
// Le rapprochement classique (bankReconciliation.js) apparie une ligne de
// relevé à un document ERP (achat, reçu, payout). Mais l'historique importé du
// xlsx est « rapproché » sans document — et l'utilisateur veut quand même
// pouvoir ouvrir la transaction QB correspondante. On interroge donc le
// rapport GeneralLedger de QB filtré sur le compte bancaire mappé
// (bank_accounts.qb_account_id, possiblement plusieurs ids séparés par
// virgule) et on apparie par montant exact + date la plus proche (±4 jours).
import { qbGet, qbEntityUrl } from '../connectors/quickbooks.js'

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
// `inAccountCurrency` : sur un compte en devise (USD), le montant de la devise
// du compte est `nat_foreign_amount`. Sur un compte CAD, ce même champ porte la
// devise de l'ÉCRITURE : une conversion USD → CAD reçue au Venn CAD (20 000 $)
// y valait 14 359,56 — le solde QB recalculé dérivait de 5 600 $ par
// conversion (Charles, 2026-10-06). Là, on garde débit − crédit.
export async function fetchQbLedgerRaw(qbAccountId, startDate, endDate, { inAccountCurrency = true } = {}) {
  // `debt_amt`/`credit_amt` sont eux aussi en devise de l'écriture : sur un
  // compte CAD, seuls `debt_home_amt`/`credit_home_amt` donnent les dollars
  // canadiens réellement passés au compte.
  const [debitKey, creditKey] = inAccountCurrency ? ['debt_amt', 'credit_amt'] : ['debt_home_amt', 'credit_home_amt']
  const cols = inAccountCurrency ? 'tx_date,txn_type,debt_amt,credit_amt,nat_foreign_amount' : `tx_date,txn_type,${debitKey},${creditKey}`
  const d = await qbGet(
    `/reports/GeneralLedger?start_date=${startDate}&end_date=${endDate}&account=${qbAccountId}&columns=${cols}`
  )
  const colKeys = (d.Columns?.Column || []).map((c) => c.MetaData?.find((m) => m.Name === 'ColKey')?.Value)
  const idx = (k) => colKeys.indexOf(k)
  const [iDate, iType, iDebit, iCredit, iForeign] =
    ['tx_date', 'txn_type', debitKey, creditKey, 'nat_foreign_amount'].map(idx)
  const entries = []
  for (const cols2 of walkRows(d.Rows?.Row, [])) {
    const date = cols2[iDate]?.value || ''
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue // "Solde initial", totaux…
    const debit = Number(cols2[iDebit]?.value || 0)
    const credit = Number(cols2[iCredit]?.value || 0)
    let amount = debit - credit
    const foreign = iForeign >= 0 ? Number(cols2[iForeign]?.value || 0) : 0
    if (foreign && inAccountCurrency) amount = Math.sign(amount || foreign) * Math.abs(foreign)
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

// Même rapport, TOUTES les écritures d'un compte QB avec leur marqueur de
// compensation (« R » = déjà rapprochée, « C » = compensée, vide = jamais vue
// à la banque) : le robot « Rapprocher » (qbReconcileRobot.js) y lit ce qui est
// encore à cocher et à quelle date / quel montant QuickBooks l'affiche.
export async function fetchQbLedgerForReconcile(qbAccountId, startDate, endDate) {
  const cols = 'tx_date,txn_type,debt_amt,credit_amt,nat_foreign_amount,is_cleared'
  const d = await qbGet(
    `/reports/GeneralLedger?start_date=${startDate}&end_date=${endDate}&account=${qbAccountId}&columns=${cols}`
  )
  const colKeys = (d.Columns?.Column || []).map((c) => c.MetaData?.find((m) => m.Name === 'ColKey')?.Value)
  const idx = (k) => colKeys.indexOf(k)
  const [iDate, iType, iDebit, iCredit, iForeign, iCleared] =
    ['tx_date', 'txn_type', 'debt_amt', 'credit_amt', 'nat_foreign_amount', 'is_cleared'].map(idx)
  const entries = []
  for (const cols2 of walkRows(d.Rows?.Row, [])) {
    const date = cols2[iDate]?.value || ''
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    let amount = Number(cols2[iDebit]?.value || 0) - Number(cols2[iCredit]?.value || 0)
    const foreign = iForeign >= 0 ? Number(cols2[iForeign]?.value || 0) : 0
    if (foreign) amount = Math.sign(amount || foreign) * Math.abs(foreign)
    if (!amount) continue
    entries.push({
      date,
      qbId: cols2[iType]?.id ? String(cols2[iType].id) : null,
      type: cols2[iType]?.value || null,
      amount: Math.round(amount * 100) / 100,
      cleared: String(cols2[iCleared]?.value || '').trim().toUpperCase() || null,
    })
  }
  return entries
}

// `linkAccountToQb` a été RETIRÉ le 2026-09-15. Il appariait au montant exact,
// à ±4 jours, sur le seul compte du relevé — et déclarait « absente de
// QuickBooks » toute écriture qui sortait de ce cadre : 83 des 94 anomalies du
// 22 août 2026 étaient ses faux positifs. Il cohabitait avec la recherche
// approfondie, qui se contredisaient sur les mêmes lignes. Un seul moteur
// désormais : services/bankQbVerify.js.

export function storedQbUrl(txn) {
  return txn.qb_txn_id && txn.qb_txn_type ? qbEntityUrl(txn.qb_txn_type, txn.qb_txn_id) : null
}
