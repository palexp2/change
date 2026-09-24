import { test } from 'node:test'
import assert from 'node:assert/strict'
import { invoiceNetHtCents, recognitionNetAmount } from './invoiceAccountingAmounts.js'

const invoice = {
  subtotal: 2320000, subtotal_excluding_tax: 2320000,
  total: 2359440, total_excluding_tax: 2088000,
  total_discount_amounts: [{ amount: 232000 }],
  total_taxes: [{ amount: 271440 }],
}
const facture = {
  currency: 'CAD', amount_before_tax_cad: 23200,
  deferred_revenue_at: '2026-09-04', deferred_revenue_amount_native: 23200,
  deferred_revenue_currency: 'CAD',
}

test('Black Creek : dépôt et constat utilisent 20 880 $ HT après 2 320 $ de rabais', () => {
  assert.equal(invoiceNetHtCents(invoice), 2088000)
  assert.equal(recognitionNetAmount(facture, invoice), 20880)
  assert.equal(recognitionNetAmount({ ...facture, deferred_revenue_at: null }, invoice), 20880)
})

test('formats Stripe moderne et historique : total moins taxes, sans double rabais', () => {
  const { total_excluding_tax: _net, total_taxes, ...legacy } = invoice
  assert.equal(invoiceNetHtCents({ ...legacy, total_taxes }), 2088000)
  assert.equal(invoiceNetHtCents({ ...legacy, total_tax_amounts: total_taxes }), 2088000)
  assert.equal(invoiceNetHtCents(legacy), 2088000)
})

test('taxes incluses : ne pas assimiler le subtotal net de rabais au hors taxes', () => {
  const inclusive = { subtotal: 11300, total: 10170, total_discount_amounts: [{ amount: 1130 }], total_taxes: [{ amount: 1170 }] }
  assert.equal(invoiceNetHtCents(inclusive), 9000)
})

test('les montants nets égaux à zéro sont conservés, mais ne créent pas de JE à zéro', () => {
  assert.equal(invoiceNetHtCents({ ...invoice, total_excluding_tax: 0 }), 0)
  assert.throws(() => recognitionNetAmount(facture, { total_excluding_tax: 0 }), /nul/)
})

test('les encaissements partiels et les devises restent respectés', () => {
  assert.equal(recognitionNetAmount({ ...facture, deferred_revenue_amount_native: 10440 }, invoice), 10440)
  assert.equal(recognitionNetAmount({ ...facture, currency: 'USD', deferred_revenue_currency: 'USD' }, invoice), 20880)
  assert.throws(() => recognitionNetAmount({ ...facture, deferred_revenue_currency: 'USD' }, invoice), /devise/)
})

test('facture sans Stripe : recouper un ancien différé brut avec le HT ERP', () => {
  assert.equal(recognitionNetAmount({ ...facture, amount_before_tax_cad: 20880 }), 20880)
  assert.throws(() => recognitionNetAmount({ ...facture, deferred_revenue_amount_native: null }), /déféré inconnu/)
})
