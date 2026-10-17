import test from 'node:test'
import assert from 'node:assert/strict'
import { parseTrialBalance, compareBalances, fiscalStartOf, monthNumber, qbPageOf } from './glReconcile.js'

// Forme réelle du rapport TrialBalance (septembre 2026, montants changés).
const TB = {
  Columns: { Column: [{ ColType: 'Account' }, { ColType: 'Money' }, { ColType: 'Money' }] },
  Rows: { Row: [
    { ColData: [{ value: '10000 Compte chèques Banque Nationale', id: '61' }, { value: '100.10' }, { value: '' }] },
    { ColData: [{ value: '10022 Compte USD:Variation de change', id: '235' }, { value: '' }, { value: '500.71' }] },
    { ColData: [{ value: '12000 Comptes clients - CAD', id: '65' }, { value: '0.00' }, { value: '' }] },
    { ColData: [{ value: '30900 Bénéfices non répartis' }, { value: '400.61' }, { value: '' }] },
    { Summary: { ColData: [{ value: 'TOTAL' }, { value: '500.71' }, { value: '500.71' }] }, type: 'Section', group: 'GrandTotal' },
  ] },
}

test('balance QBO : débit − crédit par compte, TOTAL ignoré', () => {
  assert.deepEqual(parseTrialBalance(TB), [
    { id: '61', label: '10000 Compte chèques Banque Nationale', balance: 100.1 },
    { id: '235', label: '10022 Compte USD:Variation de change', balance: -500.71 },
    { id: '65', label: '12000 Comptes clients - CAD', balance: 0 },
    { id: null, label: '30900 Bénéfices non répartis', balance: 400.61 },
  ])
})

test('comparaison : écart au cent, comptes nuls des deux côtés omis', () => {
  const rows = compareBalances(
    new Map([['61', 100.1], ['235', -500.7], ['65', 0], ['9', 3]]),
    new Map([['61', 100.1], ['235', -500.71], ['65', 0]]),
  )
  assert.deepEqual(rows.map(r => [r.account_qb_id, r.diff]), [['61', 0], ['235', 0.01], ['9', 3]])
})

test('exercice : avril → l\'exercice de mars commence l\'année d\'avant', () => {
  assert.equal(fiscalStartOf('2026-03-31', 4), '2025-04-01')
  assert.equal(fiscalStartOf('2026-04-30', 4), '2026-04-01')
  assert.equal(fiscalStartOf('2026-12-31', 1), '2026-01-01')
  assert.equal(monthNumber('April'), 4)
  assert.equal(monthNumber('4'), 4)
  assert.equal(monthNumber('avril'), 4)
  assert.equal(monthNumber('x'), null)
})

test('page QBO : un chèque n\'est pas une dépense', () => {
  assert.equal(qbPageOf('Purchase', 'Chèque'), 'check')
  assert.equal(qbPageOf('Purchase', 'Dépense'), 'expense')
  assert.equal(qbPageOf('JournalEntry'), 'journal')
  assert.equal(qbPageOf('InventoryQtyAdjust'), null)
})
