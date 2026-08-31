import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  pick, toDateOnly, collectInvoiceIds, normalizeLines, normalizeOrder, buildAchatFields,
} from './digikey.js'

// Les réponses DigiKey ont déjà changé de casse entre OrderDetails v3 (PascalCase)
// et OrderStatus v4 (camelCase) : ces tests figent la tolérance du mapping.

test('pick — insensible à la casse, ignore les valeurs vides', () => {
  assert.equal(pick({ SalesOrderId: '123' }, ['salesOrderId']), '123')
  assert.equal(pick({ salesOrderId: '' , orderNumber: 'A9' }, ['salesOrderId', 'orderNumber']), 'A9')
  assert.equal(pick(null, ['x']), undefined)
  assert.equal(pick({ a: 0 }, ['a']), 0)
})

test('toDateOnly — garde la date métier sans composante horaire', () => {
  assert.equal(toDateOnly('2026-08-14T18:22:03.5Z'), '2026-08-14')
  assert.equal(toDateOnly('2026-08-14'), '2026-08-14')
  assert.equal(toDateOnly(null), null)
  assert.equal(toDateOnly('pas une date'), null)
})

test('collectInvoiceIds — trouve les factures où qu\'elles soient nichées', () => {
  const order = {
    salesOrderId: 88123,
    shippingDetails: [
      { invoiceId: 71234567, carrier: 'UPS' },
      { invoiceId: 71234568 },
    ],
    meta: { nested: { InvoiceNumber: '71234567' } },
  }
  assert.deepEqual(collectInvoiceIds(order), ['71234567', '71234568'])
  assert.deepEqual(collectInvoiceIds({ shippingDetails: [{ invoiceId: 0 }] }), [])
  assert.deepEqual(collectInvoiceIds(null), [])
})

test('normalizeLines — quantité × prix quand le total de ligne manque', () => {
  const lines = normalizeLines({
    lineItems: [
      { digiKeyPartNumber: '399-1234-ND', description: 'CAP CER 10UF', quantityOrdered: 10, unitPrice: 0.25, totalPrice: 2.5 },
      { manufacturerPartNumber: 'RL-42', quantityOrdered: 3, unitPrice: 1.1 },
    ],
  })
  assert.equal(lines.length, 2)
  assert.equal(lines[0].description, '399-1234-ND — CAP CER 10UF')
  assert.equal(lines[0].amount, 2.5)
  assert.equal(lines[1].amount, 3.3) // 3 × 1,10 déduit
  assert.equal(lines[1].item_name, 'RL-42')
})

test('normalizeOrder — total déclaré prioritaire, sinon produits + transport + taxes', () => {
  const withTotal = normalizeOrder({
    salesOrderId: 88123, dateEntered: '2026-08-14T12:00:00Z', currencyCode: 'cad',
    totalPrice: 100, freight: 15, salesTax: 17.24, orderTotal: 132.24,
  })
  assert.equal(withTotal.salesOrderId, '88123')
  assert.equal(withTotal.orderDate, '2026-08-14')
  assert.equal(withTotal.currency, 'CAD')
  assert.equal(withTotal.total, 132.24)

  const computed = normalizeOrder({ SalesOrderId: 5, totalPrice: 100, freight: 15, salesTax: 17.24 })
  assert.equal(computed.total, 132.24)
  assert.equal(computed.subtotal, 100)
})

test('buildAchatFields — amount + tax = total, brouillon, jamais de montant négatif', () => {
  const order = normalizeOrder({
    salesOrderId: 88123, dateEntered: '2026-08-14', purchaseOrder: 'BC-77',
    totalPrice: 100, freight: 15, salesTax: 17.24,
    lineItems: [{ digiKeyPartNumber: 'X', quantityOrdered: 1, unitPrice: 100, totalPrice: 100 }],
  })
  const f = buildAchatFields(order, { vendorName: 'DigiKey', invoiceId: '71234567' })

  assert.equal(f.type, 'bill')
  assert.equal(f.status, 'Brouillon')
  assert.equal(f.vendor, 'DigiKey')
  assert.equal(f.vendor_invoice_number, '71234567')
  assert.equal(f.reference, 'DigiKey 88123')
  assert.equal(f.date_achat, '2026-08-14')
  assert.equal(Number((f.amount_cad + f.tax_cad).toFixed(2)), f.total_cad)
  assert.equal(f.tax_cad, 17.24)
  assert.equal(f.total_cad, 132.24)
  assert.match(f.description, /BC-77/)
  assert.ok(JSON.parse(f.lines).length === 1)

  // Sans facture : la commande sert de clé, et une réponse vide ne produit
  // jamais de montant négatif.
  const bare = buildAchatFields(normalizeOrder({ salesOrderId: 9 }), {})
  assert.equal(bare.vendor_invoice_number, '9')
  assert.equal(bare.amount_cad, 0)
  assert.equal(bare.total_cad, 0)
})
