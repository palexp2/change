import { test } from 'node:test'
import assert from 'node:assert/strict'
import { preferInvoiceNumber } from './saleReceiptTwin.js'

const STRIPE_RECEIPT = 'Receipt\nInvoice number HNBAEQSN-0008\nReceipt number 2265-1094\nDate paid October 11, 2026'

test('reçu Stripe : le numéro de facture remplace le numéro de reçu', () => {
  assert.equal(preferInvoiceNumber('2265-1094', STRIPE_RECEIPT), 'HNBAEQSN-0008')
  assert.equal(preferInvoiceNumber(null, STRIPE_RECEIPT), 'HNBAEQSN-0008')
})

test('numéro déjà correct ou document sans les deux numéros : inchangé', () => {
  assert.equal(preferInvoiceNumber('HNBAEQSN-0008', STRIPE_RECEIPT), null)
  assert.equal(preferInvoiceNumber('ABC-1', 'Invoice number HNBAEQSN-0008\nDate due'), null)
  assert.equal(preferInvoiceNumber('ABC-1', null), null)
})
