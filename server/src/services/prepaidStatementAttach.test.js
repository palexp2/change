import test from 'node:test'
import assert from 'node:assert'
import { normalizeVendorName, resolveStatementMonth, monthLabel, isPaymentReceiptDocument } from './prepaidStatementAttach.js'

test('normalizeVendorName ignore la forme juridique et la ponctuation', () => {
  assert.equal(normalizeVendorName('Twilio, Inc.'), 'twilio')
  assert.equal(normalizeVendorName('Twilio Inc'), 'twilio')
  assert.equal(normalizeVendorName('  TWILIO '), 'twilio')
  assert.notEqual(normalizeVendorName('Twilio'), normalizeVendorName('Stripe'))
})

test('mois tiré de la période couverte, dans ses trois écritures', () => {
  assert.deepEqual(resolveStatementMonth({ service_period: 'juillet 2026' }),
    { month: '2026-07', source: 'période couverte' })
  assert.equal(resolveStatementMonth({ service_period: 'Période 2026-07' }).month, '2026-07')
  assert.equal(resolveStatementMonth({ service_period: '07/2026' }).month, '2026-07')
  assert.equal(resolveStatementMonth({ service_period: 'août 2026' }).month, '2026-08')
})

test('à défaut : mois du nom de fichier Twilio, puis date du document', () => {
  const row = { original_name: 'AC931814-2026-07-IVa90a7b067126.pdf', receipt_date: '2026-08-02' }
  assert.deepEqual(resolveStatementMonth(row), { month: '2026-07', source: 'nom du fichier' })
  // Document daté en fin de mois → ce mois-là.
  assert.equal(resolveStatementMonth({ receipt_date: '2026-07-31' }).month, '2026-07')
  // Facture émise le 2 du mois suivant → mois précédent (celui qu'elle récapitule).
  assert.equal(resolveStatementMonth({ receipt_date: '2026-08-02' }).month, '2026-07')
  assert.equal(resolveStatementMonth({ receipt_date: '2026-01-03' }).month, '2025-12')
  assert.equal(resolveStatementMonth({}), null)
})

test('monthLabel en français', () => {
  assert.equal(monthLabel('2026-07'), 'juillet 2026')
  assert.equal(monthLabel('2026-12'), 'décembre 2026')
})

test('isPaymentReceiptDocument distingue la facture d\'usage du reçu de paiement Twilio', () => {
  assert.equal(isPaymentReceiptDocument({
    original_name: 'ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-2026-07-IVa90a7b067126.pdf',
  }), false)
  assert.equal(isPaymentReceiptDocument({
    original_name: 'receipt--ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-2026-076878741464.pdf',
  }), true)
  assert.equal(isPaymentReceiptDocument({
    original_name: 'receipt_ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-2026-076878741464.pdf',
  }), true)
  assert.equal(isPaymentReceiptDocument({}), false)
})
