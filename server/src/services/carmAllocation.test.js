import { test } from 'node:test'
import assert from 'node:assert/strict'
import { allocateFifo, pairBrokerLines } from './carmPosting.js'

const charge = (id, date, amount, o = {}) => ({ id, transaction_date: date, amount, kind: 'tps', ...o })
const payment = (id, date, amount, o = {}) => ({ id, transaction_date: date, amount, kind: 'paiement', payer: 'nous', ...o })

test('une correction négative n’absorbe pas de versement', () => {
  const r = allocateFifo({
    charges: [charge('c1', '2026-07-09', 345.10), charge('c2', '2026-07-09', -79.46), charge('c3', '2026-07-09', 31.68)],
    payments: [payment('p1', '2026-08-03', -500)],
  })
  // seules les charges positives consomment le versement : 345,10 − 79,46 est
  // déjà net dans le relevé, on n'impute que ce qui est dû
  const total = r.allocations.reduce((s, a) => s + a.amount, 0)
  assert.equal(Math.round(total * 100) / 100, 376.78)
  assert.equal(r.credit_available, 123.22)
})

test('cas réel : 297,32 $ de charges ouvertes, versement de 500 $', () => {
  const r = allocateFifo({
    charges: [charge('c1', '2026-06-30', 30.20), charge('c2', '2026-07-09', 265.68), charge('c3', '2026-07-31', 1.44)],
    payments: [payment('p1', '2026-08-03', -500)],
  })
  assert.equal(r.allocations.length, 3)
  assert.equal(r.unpaid, 0)
  assert.equal(r.credit_available, 202.68)
})

test('FIFO : la charge la plus ancienne est réglée en premier', () => {
  const r = allocateFifo({
    charges: [charge('recent', '2026-08-01', 100), charge('ancienne', '2026-05-01', 100)],
    payments: [payment('p1', '2026-08-05', -100)],
  })
  assert.equal(r.allocations.length, 1)
  assert.equal(r.allocations[0].charge_txn_id, 'ancienne')
  assert.equal(r.unpaid, 100)
})

test('la date d’échéance prime sur la date de transaction', () => {
  const r = allocateFifo({
    charges: [charge('a', '2026-05-01', 50, { due_date: '2026-09-30' }), charge('b', '2026-06-01', 50, { due_date: '2026-06-30' })],
    payments: [payment('p', '2026-07-01', -50)],
  })
  assert.equal(r.allocations[0].charge_txn_id, 'b')
})

test('une allocation manuelle est posée avant le FIFO et survit', () => {
  const r = allocateFifo({
    charges: [charge('a', '2026-05-01', 100), charge('b', '2026-06-01', 100)],
    payments: [payment('p', '2026-07-01', -100)],
    manual: [{ payment_txn_id: 'p', charge_txn_id: 'b', amount: 100 }],
  })
  assert.equal(r.allocations.length, 1)
  assert.deepEqual(
    { c: r.allocations[0].charge_txn_id, m: r.allocations[0].method },
    { c: 'b', m: 'manuel' })
})

test('idempotence : deux calculs successifs donnent le même lettrage', () => {
  const input = {
    charges: [charge('a', '2026-05-01', 40), charge('b', '2026-06-01', 60)],
    payments: [payment('p', '2026-07-01', -80)],
  }
  assert.deepEqual(allocateFifo(input), allocateFifo(input))
})

test('un versement partiel laisse la charge ouverte, sans crédit', () => {
  const r = allocateFifo({ charges: [charge('a', '2026-05-01', 100)], payments: [payment('p', '2026-06-01', -30)] })
  assert.equal(r.credit_available, 0)
  assert.equal(r.unpaid, 70)
  assert.deepEqual(r.open_charges, [{ id: 'a', left: 70 }])
})

test('courtier : charge et encaissement du même montant s’annulent', () => {
  const pairs = pairBrokerLines([
    charge('c', '2026-06-30', 30.20, { broker: 'FedEx' }),
    payment('p', '2026-08-12', -30.20, { broker: 'FedEx', payer: 'courtier' }),
  ])
  assert.deepEqual(pairs, [{ broker: 'FedEx', charge_txn_id: 'c', payment_txn_id: 'p', amount: 30.20 }])
})

test('courtier : un encaissement couvre deux charges', () => {
  const pairs = pairBrokerLines([
    charge('c1', '2026-01-14', 145.92, { broker: 'FedEx' }),
    charge('c2', '2026-01-15', 130.08, { broker: 'FedEx' }),
    payment('p', '2026-01-30', -276.00, { broker: 'FedEx', payer: 'courtier' }),
  ])
  assert.equal(pairs.length, 2)
  assert.equal(pairs.reduce((s, p) => s + p.amount, 0), 276)
})

test('courtier : une charge sans encaissement n’est pas appariée', () => {
  const pairs = pairBrokerLines([charge('c', '2026-06-30', 30.20, { broker: 'FedEx' })])
  assert.deepEqual(pairs, [])
})

test('courtier : chacun son sous-grand-livre, jamais de croisement', () => {
  const pairs = pairBrokerLines([
    charge('cf', '2026-06-01', 100, { broker: 'FedEx' }),
    payment('pu', '2026-06-10', -100, { broker: 'UPS', payer: 'courtier' }),
  ])
  assert.deepEqual(pairs, [])
})

test('nos versements ne sont jamais appariés comme ceux d’un courtier', () => {
  const pairs = pairBrokerLines([
    charge('c', '2026-06-01', 100, { broker: 'FedEx' }),
    payment('p', '2026-06-10', -100, { broker: null, payer: 'nous' }),
  ])
  assert.deepEqual(pairs, [])
})
