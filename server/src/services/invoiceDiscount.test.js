import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanDiscount, cleanDiscounts, discountAmount, discountsBreakdown, pendingInvoiceTotals } from './invoiceDiscount.js'

test('cleanDiscount : aucun, invalide, borné', () => {
  assert.equal(cleanDiscount(null), null)
  assert.equal(cleanDiscount({ kind: 'percent', value: 0 }), null)
  assert.throws(() => cleanDiscount({ kind: 'percent', value: 120 }))
  assert.throws(() => cleanDiscount({ kind: 'amount', value: -5 }))
  assert.deepEqual(cleanDiscount({ kind: 'amount', value: '25.456', name: ' Fidélité ' }), { kind: 'amount', value: 25.46, name: 'Fidélité' })
})

test('discountAmount : % et $, plafonné au sous-total', () => {
  assert.equal(discountAmount({ kind: 'percent', value: 10 }, 199.99), 20)
  assert.equal(discountAmount({ kind: 'amount', value: 500 }, 300), 300)
})

test('pendingInvoiceTotals : net = lignes − rabais', () => {
  const t = pendingInvoiceTotals({
    items_json: JSON.stringify([{ qty: 2, unit_price: 100 }, { qty: 1, unit_price: 50 }]),
    discount_json: JSON.stringify({ kind: 'percent', value: 15 }),
  })
  assert.equal(t.subtotal, 250)
  assert.equal(t.discount_amount, 37.5)
  assert.equal(t.net, 212.5)
  assert.equal(pendingInvoiceTotals({ items_json: '[{"qty":1,"unit_price":10}]' }).net, 10)
})

test('plusieurs rabais : chacun sur le brut, somme plafonnée', () => {
  assert.deepEqual(cleanDiscounts([{ kind: 'percent', value: 10 }, null, { kind: 'amount', value: 0 }]), [{ kind: 'percent', value: 10 }])
  const t = pendingInvoiceTotals({
    items_json: JSON.stringify([{ qty: 1, unit_price: 200 }]),
    discount_json: JSON.stringify([{ kind: 'percent', value: 10, name: 'Volume' }, { kind: 'amount', value: 30 }]),
  })
  assert.deepEqual(t.discounts.map(d => d.amount), [20, 30])
  assert.equal(t.discount_amount, 50)
  assert.equal(t.net, 150)
  assert.equal(discountsBreakdown([{ kind: 'amount', value: 150 }, { kind: 'amount', value: 100 }], 200).total, 200)
})
