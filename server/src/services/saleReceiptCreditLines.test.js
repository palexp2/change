import { test } from 'node:test'
import assert from 'node:assert'
import { reconcileCreditLines } from './saleReceiptExtraction.js'

test('crédit de proration Anthropic passé en négatif', () => {
  const items = [
    { description: 'Remaining time on 3 × Team plan - Premium after 22 Jul 2026', quantity: 3, unit_price: 0, total: 512.91 },
    { description: 'Unused time on 2 × Team plan - Premium after 22 Jul 2026', quantity: 2, unit_price: 0, total: 341.94 },
  ]
  const out = reconcileCreditLines(items, 170.97)
  assert.deepEqual(out.map(i => i.total), [512.91, -341.94])
  assert.equal(Math.round(out.reduce((s, i) => s + i.total, 0) * 100) / 100, 170.97)
})

test('lignes déjà cohérentes intouchées', () => {
  const items = [{ description: 'Unused time on 1 × plan', total: -50 }, { description: 'Plan', total: 150 }]
  assert.equal(reconcileCreditLines(items, 100), items)
})

test('pas de crédit identifiable → aucun changement', () => {
  const items = [{ description: 'Widget A', total: 100 }, { description: 'Widget B', total: 50 }]
  assert.equal(reconcileCreditLines(items, 120), items)
})

test('inversion qui ne retombe pas sur le sous-total → aucun changement', () => {
  const items = [{ description: 'Plan', total: 100 }, { description: 'Crédit', total: 40 }]
  assert.equal(reconcileCreditLines(items, 90), items)
})
