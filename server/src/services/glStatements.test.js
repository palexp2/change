import test from 'node:test'
import assert from 'node:assert/strict'
import { parseQboStatement, buildStatement, BALANCE_LAYOUT, INCOME_LAYOUT } from './glStatements.js'

const money = [{ ColType: 'Account' }, { ColType: 'Money' }]
const data = (label, id, v, group) => ({ ColData: [{ value: label, ...(id ? { id } : {}) }, { value: String(v) }], ...(group ? { group } : {}) })
const section = (group, label, id, rows, total) => ({
  type: 'Section', ...(group ? { group } : {}),
  Header: { ColData: [{ value: label, ...(id ? { id } : {}) }, { value: '' }] },
  Rows: { Row: rows }, Summary: { ColData: [{ value: `Total ${label}` }, { value: String(total) }] },
})

const ACCOUNTS = [
  { qb_id: '1', acct_num: '10000', name: 'Banque', account_type: 'Bank', classification: 'Asset' },
  { qb_id: '5', acct_num: '12900', name: 'Fonds non déposés', account_type: 'Other Current Asset', account_sub_type: 'UndepositedFunds', classification: 'Asset' },
  { qb_id: '2', acct_num: '14100', name: 'Matériel', account_type: 'Fixed Asset', classification: 'Asset' },
  { qb_id: '3', acct_num: '14101', name: 'Amort', account_type: 'Fixed Asset', classification: 'Asset', parent_qb_id: '2' },
  { qb_id: '4', acct_num: '21000', name: 'Fournisseurs', account_type: 'Accounts Payable', classification: 'Liability' },
  { qb_id: '6', acct_num: '30000', name: 'Capital', account_type: 'Equity', classification: 'Equity' },
  { qb_id: '7', acct_num: '40000', name: 'Ventes', account_type: 'Income', classification: 'Revenue' },
  { qb_id: '8', acct_num: '50000', name: 'Achats', account_type: 'Cost of Goods Sold', classification: 'Expense' },
  { qb_id: '9', acct_num: '60000', name: 'Loyer', account_type: 'Expense', classification: 'Expense' },
]

test('rapport QBO : comptes (parents = total des sous-comptes) et groupes', () => {
  const r = parseQboStatement({ Columns: { Column: money }, Rows: { Row: [
    section('TotalAssets', 'ACTIFS', null, [
      section(null, '14100 Matériel', '2', [data('14101 Amort', '3', -40)], 60),
    ], 60),
    data('Bénéfice de l’année', null, -5, 'NetIncome'),
  ] } })
  assert.equal(r.accounts.get('2'), 60)
  assert.equal(r.accounts.get('3'), -40)
  assert.equal(r.groups.get('TotalAssets'), 60)
  assert.equal(r.groups.get('NetIncome'), -5)
})

test('bilan : signe naturel, sous-comptes cumulés, fonds non déposés en trésorerie, écart', () => {
  const amounts = new Map([['1', 100], ['5', 10], ['2', 100], ['3', -40], ['4', -50], ['6', -90]])
  const qbo = { accounts: new Map([['1', 100], ['5', 10], ['2', 60], ['3', -40], ['4', 50], ['6', 90]]),
    groups: new Map([['TotalAssets', 170], ['BankAccounts', 110], ['Liabilities', 50], ['Equity', 120], ['NetIncome', 30]]) }
  const bs = ACCOUNTS.filter(a => ['Asset', 'Liability', 'Equity'].includes(a.classification))
  const rows = buildStatement(BALANCE_LAYOUT, bs, amounts, { special: { netIncome: 30 }, qbo })
  const by = (id) => rows.find(r => r.id === id)
  assert.equal(by('gBankAccounts').boreal, 110)
  assert.equal(by('a2').boreal, 60)
  assert.equal(by('a3').depth, by('a2').depth + 1)
  assert.equal(by('a4').boreal, 50)
  assert.equal(by('gEquity').boreal, 120)
  assert.equal(by('tTotalLiabilitiesAndEquity').boreal, 170)
  assert.ok(rows.every(r => r.diff === 0), JSON.stringify(rows.filter(r => r.diff)))
})

test('résultats : totaux calculés quand QBO ne les donne pas, écart par compte', () => {
  const amounts = new Map([['7', -1000], ['8', 300], ['9', 200]])
  const qbo = { accounts: new Map([['7', 1000], ['8', 300], ['9', 250]]),
    groups: new Map([['Income', 1000], ['COGS', 300], ['Expenses', 250], ['NetIncome', 450]]) }
  const rows = buildStatement(INCOME_LAYOUT, ACCOUNTS.filter(a => ['Revenue', 'Expense'].includes(a.classification)), amounts, { qbo })
  const by = (id) => rows.find(r => r.id === id)
  assert.equal(by('tGrossProfit').boreal, 700)
  assert.equal(by('tGrossProfit').qbo, 700)
  assert.equal(by('tNetIncome').boreal, 500)
  assert.equal(by('tNetIncome').diff, 50)
  assert.equal(by('a9').diff, -50)
})

test('compte nul des deux côtés masqué ; compte QBO hors plan visible', () => {
  const qbo = { accounts: new Map([['99', 12]]), groups: new Map() }
  const rows = buildStatement(INCOME_LAYOUT, ACCOUNTS.filter(a => a.classification === 'Revenue'), new Map(), { qbo })
  assert.equal(rows.find(r => r.id === 'a7'), undefined)
  assert.equal(rows.find(r => r.id === 'x99').diff, -12)
})
