import { test } from 'node:test'
import assert from 'node:assert/strict'
import { linkGroups, merchantKey } from './bankReconcileSheet.js'

const row = (bank, qb) => ({ bank, qb })

test('merchantKey ignore les chiffres collés au nom', () => {
  assert.equal(merchantKey('FEDEX272708328  T1800'), 'fedex')
  assert.equal(merchantKey('-FEDEX- CANADA'), 'fedex')
})

test('remboursement sans écriture : le débit passé à QB et son crédit seul', () => {
  const debit = row({ date: '2026-05-04', label: '-FEDEX- CANADA', amount: -2.4 }, { date: '2026-05-04', label: 'FedEx', amount: -2.4 })
  const credit = row({ date: '2026-05-01', label: 'FEDEX272708328', amount: 2.4 }, null)
  const groups = linkGroups([debit, credit])
  assert.equal(groups[0].kind, 'rembourse')
  assert.equal(debit.group, 'A')
  assert.equal(credit.group, 'A')
})
