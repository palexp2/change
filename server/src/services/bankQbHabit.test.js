import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shapeOf } from './bankQbHabit.js'

test('virement entrant : le contre-compte est la source', () => {
  const s = shapeOf('transfer', {
    FromAccountRef: { value: '176', name: 'Marge de crédit Banque nationale' },
    ToAccountRef: { value: '61', name: 'Compte chèques Banque Nationale' },
  }, ['61'])
  assert.deepEqual(s, { k: 'transfer', acct: '176', name: 'Marge de crédit Banque nationale', memo: null })
})

test('virement sortant : le contre-compte est la destination', () => {
  const s = shapeOf('transfer', { FromAccountRef: { value: '61' }, ToAccountRef: { value: '28', name: 'Frais d\'intérêts' }, PrivateNote: 'Intérêts' }, ['61'])
  assert.equal(s.acct, '28')
  assert.equal(s.memo, 'Intérêts')
})

test('dépôt d\'un seul compte, dépôt de paiements clients', () => {
  const one = shapeOf('deposit', { Line: [{ Amount: 0.05, Description: 'Intérêts', DepositLineDetail: { AccountRef: { value: '90', name: 'Revenus d\'intérêts' } } }] })
  assert.deepEqual(one, { k: 'deposit', acct: '90', name: 'Revenus d\'intérêts', memo: 'Intérêts' })
  const linked = shapeOf('deposit', { Line: [{ Amount: 10, LinkedTxn: [{ TxnId: '1' }] }] })
  assert.equal(linked.k, 'deposit_linked')
})

test('dépense : fournisseur, compte et taxe uniques', () => {
  const s = shapeOf('expense', {
    EntityRef: { name: 'Digi-Key' },
    Line: [{ Amount: 10, AccountBasedExpenseLineDetail: { AccountRef: { value: '70', name: 'Stock' }, TaxCodeRef: { value: '5' } } }],
  })
  assert.deepEqual(s, { k: 'expense', vendor: 'Digi-Key', acct: '70', name: 'Stock', tax: '5', memo: null })
})
