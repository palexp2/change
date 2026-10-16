// Historique des opérations d'un compte QB (Plan comptable → clic sur un compte).
//
// Source : rapport GeneralLedger filtré sur le compte, sous-comptes inclus
// (QB les rend en sections imbriquées sous celle du compte). On ne garde que
// la section du compte demandé : le filtre `account` du rapport laisse parfois
// passer d'autres comptes (gotcha « GeneralLedger double-compte »).
//
// Montants : compte CAD → `debt_home_amt`/`credit_home_amt` (les colonnes
// « étrangères » y portent la devise de l'ÉCRITURE) ; compte en devise →
// `debt_amt`/`credit_amt`, en devise du compte.
//
// Solde courant : le rapport ne fournit pas de colonne de solde. Pour un compte
// de bilan, `CurrentBalanceWithSubAccounts` = Σ(débit − crédit) (vérifié sur
// actif, passif, capitaux propres) : on part du solde actuel et on remonte. Un
// compte de résultat n'a pas de solde QB (0) : on cumule depuis le début de la
// période.
import { qbGet, qbEntityUrl } from '../connectors/quickbooks.js'
import { TXN_TYPE_ENTITY } from './bankQbLink.js'

const round2 = n => Math.round(n * 100) / 100
const PNL = new Set(['Revenue', 'Expense'])

export async function fetchAccountLedger(accountId, since) {
  const id = String(accountId)
  if (!/^\d+$/.test(id)) throw new Error('Compte invalide')
  const q = encodeURIComponent(`SELECT * FROM Account WHERE Id = '${id}'`)
  const account = (await qbGet(`/query?query=${q}`)).QueryResponse?.Account?.[0]
  if (!account) throw new Error('Compte introuvable dans QuickBooks')

  const currency = account.CurrencyRef?.value || 'CAD'
  const [debitKey, creditKey] = currency === 'CAD' ? ['debt_home_amt', 'credit_home_amt'] : ['debt_amt', 'credit_amt']
  const cols = `tx_date,txn_type,doc_num,name,memo,split_acc,${debitKey},${creditKey}`
  // Fin lointaine : les écritures post-datées comptent dans le solde actuel.
  const end = new Date(Date.now() + 400 * 86400e3).toISOString().slice(0, 10)
  const d = await qbGet(`/reports/GeneralLedger?start_date=${since}&end_date=${end}&account=${id}&columns=${cols}`)
  const keys = (d.Columns?.Column || []).map(c => c.MetaData?.find(m => m.Name === 'ColKey')?.Value)
  const at = k => keys.indexOf(k)
  const [iDate, iType, iDoc, iName, iMemo, iSplit, iDebit, iCredit] =
    ['tx_date', 'txn_type', 'doc_num', 'name', 'memo', 'split_acc', debitKey, creditKey].map(at)

  const rows = []
  // `sub` : nom du sous-compte quand la ligne vient d'une section imbriquée.
  const walk = (list, sub) => {
    for (const r of list || []) {
      if (r.Rows?.Row) {
        const head = r.Header?.ColData?.[0]
        walk(r.Rows.Row, head?.id && head.id !== id ? head.value : sub)
      }
      const c = r.ColData
      if (!c || !/^\d{4}-\d{2}-\d{2}$/.test(c[iDate]?.value || '')) continue // « Solde initial »
      const debit = Number(c[iDebit]?.value || 0)
      const credit = Number(c[iCredit]?.value || 0)
      if (!debit && !credit) continue
      const type = c[iType]?.value || ''
      const entity = TXN_TYPE_ENTITY[type]
      const txnId = c[iType]?.id || null
      rows.push({
        date: c[iDate].value,
        type,
        doc_num: c[iDoc]?.value || '',
        name: c[iName]?.value || '',
        memo: c[iMemo]?.value || '',
        split: c[iSplit]?.value || '',
        sub_account: sub || '',
        debit: round2(debit),
        credit: round2(credit),
        url: entity && txnId ? qbEntityUrl(entity, txnId) : null,
      })
    }
  }
  const top = (d.Rows?.Row || []).filter(r => r.Header?.ColData?.[0]?.id === id)
  walk(top.length ? top : d.Rows?.Row, null)

  rows.sort((a, b) => a.date.localeCompare(b.date))
  const pnl = PNL.has(account.Classification)
  let balance = 0
  if (!pnl) {
    const current = Number(account.CurrentBalanceWithSubAccounts ?? account.CurrentBalance ?? 0)
    balance = current - rows.reduce((s, r) => s + r.debit - r.credit, 0)
  }
  const opening = round2(balance)
  rows.forEach((r, i) => {
    balance += r.debit - r.credit
    r.balance = round2(balance)
    r.id = `${i}`
  })
  return { currency, pnl, opening, rows: rows.reverse() }
}
