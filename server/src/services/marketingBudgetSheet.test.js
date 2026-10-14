import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildFyGrid, fiscalYearsToMirror, fyTabTitle, colLetter, SHEET_BLOCKS } from './marketingBudgetSheet.js'
import { fiscalMonths } from './marketingBudget.js'

test('années financières à tenir : de start_date à aujourd\'hui (avril → mars)', () => {
  assert.deepEqual(fiscalYearsToMirror('2026-06-01', '2026-10-13'), ['2026'])
  assert.deepEqual(fiscalYearsToMirror('2025-04-01', '2027-04-02'), ['2025', '2026', '2027'])
  assert.equal(fyTabTitle('2026'), '2026 Réel')
})

test('colLetter', () => {
  assert.equal(colLetter(0), 'A')
  assert.equal(colLetter(30), 'AE')
})

test('grille : clone de l\'ancien onglet (blocs, libellés, sommes)', () => {
  const months = fiscalMonths('2026')
  const blocks = SHEET_BLOCKS.map(b => ({ ...b, lines: [] }))
  blocks[0].lines = [
    { vendor: 'Luke', budget: { '2026-08': 900 }, real: {} },
    { vendor: 'Mickael KilPatrick', budget: { '2026-07': 3000 }, real: {} },
    { vendor: 'Andrew Mefferd', budget: {}, real: { '2026-06': 266.03 } },
  ]
  const { rows } = buildFyGrid(months, blocks)
  const s = c => c?.userEnteredValue?.stringValue
  const f = c => c?.userEnteredValue?.formulaValue
  assert.equal(s(rows[0][4]), 'Expenses')
  assert.equal(s(rows[0][5]), 'Apr')
  assert.equal(s(rows[2][1]), 'Partners')
  assert.equal(s(rows[2][4]), 'Quickbooks: #75915 Partenaires')
  assert.equal(f(rows[2][5]), '=SUM(F4:F6)')
  assert.equal(s(rows[3][1]), 'Budget : 3900$')
  assert.equal(s(rows[4][1]), 'Équivalent en matériels et échange de services')
  assert.equal(s(rows[3][4]), 'Luke')
  assert.equal(rows[3][13].userEnteredValue.numberValue, 900)
  // bloc vide : 2 rangées minimum
  assert.equal(s(rows[7][1]), 'Design + Content')
  assert.equal(s(rows[8][1]), 'Budget : 0$')
  const total = rows[rows.length - 1]
  assert.equal(s(total[4]), 'Total:')
  assert.equal(s(total[1]), 'Total Budget : 3900$')
})
