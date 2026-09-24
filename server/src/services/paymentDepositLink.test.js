import { test } from 'node:test'
import assert from 'node:assert/strict'
import { depositCreditAccount } from './paymentDepositLink.js'

const line = (customer, account) => ({ DepositLineDetail: {
  Entity: { value: customer, type: 'CUSTOMER' },
  AccountRef: { value: account, name: 'Revenus perçus d’avance' },
} })

test('dépôt 17922 : rattachement manuel sans identifiant client ERP', () => {
  const deposit = { Id: '17922', Line: [line('100000001', '123')] }
  assert.equal(depositCreditAccount(deposit, [null, null]).value, '123')
})

test('un client connu doit correspondre, et seul son compte est annoté', () => {
  const deposit = { Line: [line('other', '456'), line('100000001', '123')] }
  assert.equal(depositCreditAccount(deposit, [100000001]).value, '123')
  assert.throws(() => depositCreditAccount(deposit, ['missing']), { status: 400 })
})

test('sans correspondance ERP, les comptes ambigus restent sans annotation', () => {
  assert.equal(depositCreditAccount({ Line: [line('a', '123'), line('b', '456')] }, []), null)
  assert.equal(depositCreditAccount({ Line: [] }, []), null)
  assert.equal(depositCreditAccount({ Line: [line('a', '123'), line('b', '123')] }, []).value, '123')
})
