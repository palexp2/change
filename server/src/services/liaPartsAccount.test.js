import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyPartsAccount, allLinesAreParts, isLiaLine } from './liaPartsAccount.js'

test('ligne LIA → compte des pièces, même si un autre compte était choisi', () => {
  const items = [
    { description: 'LIA-1991\tSIM Simplex CAN', total: 40, expense_account_id: '77' },
    { description: 'Transport', total: 12, expense_account_id: '88' },
    { description: 'Moteur', purchase_id: 'p1', total: 100 },
  ]
  const out = applyPartsAccount(items, 55)
  assert.deepEqual(out.map(i => i.expense_account_id), ['55', '88', '55'])
  assert.equal(allLinesAreParts(out), false)
  assert.equal(allLinesAreParts([items[0], items[2]]), true)
})

test('sans compte résolu ou sans ligne LIA : rien ne bouge', () => {
  const items = [{ description: 'Câble', total: 5 }]
  assert.equal(applyPartsAccount(items, 55), items)
  assert.equal(applyPartsAccount([{ description: 'lia-12' }], null)[0].expense_account_id, undefined)
  assert.equal(isLiaLine({ description: '  lia-12 pièce' }), true)
  assert.equal(isLiaLine({ description: 'voir LIA-12' }), false)
})
