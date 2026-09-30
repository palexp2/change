// Exécution : `node --test client/src/lib/subscriptionPricing.test.js`
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { subscriptionTotals } from './subscriptionPricing.js'

const items = [{ total: 100, currency: 'CAD' }, { total: 50, currency: 'CAD' }]

test('rabais en montant fixe', () => {
  assert.deepEqual(subscriptionTotals({ items, discount: { amount_off: 20 } }),
    { itemsSubtotal: 150, discountAmt: 20, subtotal: 130, currency: 'CAD' })
})

test('rabais en pourcentage', () => {
  assert.deepEqual(subscriptionTotals({ items, discount: { percent_off: 10 } }),
    { itemsSubtotal: 150, discountAmt: 15, subtotal: 135, currency: 'CAD' })
})

test('sans rabais', () => {
  assert.deepEqual(subscriptionTotals({ items, discount: null }),
    { itemsSubtotal: 150, discountAmt: 0, subtotal: 150, currency: 'CAD' })
})

test('sans items', () => {
  assert.deepEqual(subscriptionTotals(null), { itemsSubtotal: 0, discountAmt: 0, subtotal: 0, currency: '' })
})
