// Une facture publiée peut être appariée par QuickBooks à une opération bancaire déjà
// téléchargée (Bell Mobilité prélevée sur la Mastercard) : elle apparaît alors payée
// sans que l'ERP y soit pour quelque chose. On doit savoir la reconnaître.

import test from 'node:test'
import assert from 'node:assert/strict'

const { linkedBillPaymentIds } = await import('./quickbooks.js')

test('BillPaymentCheck et BillPaymentCreditCard comptent comme paiement', () => {
  assert.deepEqual(linkedBillPaymentIds({ LinkedTxn: [{ TxnId: '17889', TxnType: 'BillPaymentCheck' }] }), ['17889'])
  assert.deepEqual(linkedBillPaymentIds({ LinkedTxn: [{ TxnId: '5', TxnType: 'BillPaymentCreditCard' }] }), ['5'])
})

test('facture sans lien ou liée à autre chose — aucun paiement', () => {
  assert.deepEqual(linkedBillPaymentIds({}), [])
  assert.deepEqual(linkedBillPaymentIds({ LinkedTxn: [{ TxnId: '9', TxnType: 'PurchaseOrder' }] }), [])
})
