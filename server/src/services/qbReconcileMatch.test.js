import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseMoney, parseScreenDate, detectDateOrder, formatDateFor, endingBalanceFor, buildExpected, matchScreen,
} from './qbReconcileMatch.js'

test('parseMoney : formats FR, EN, négatifs', () => {
  assert.equal(parseMoney('1 234,56 $'), 1234.56)
  assert.equal(parseMoney('$1,234.56'), 1234.56)
  assert.equal(parseMoney('-12,34 $'), -12.34)
  assert.equal(parseMoney('(12.34)'), -12.34)
  assert.equal(parseMoney('25 000'), 25000)
  assert.equal(parseMoney('0,00 $'), 0)
  assert.equal(parseMoney('Dépôt'), null)
})

test('dates : détection jour/mois, parsing, format de saisie', () => {
  assert.equal(detectDateOrder(['03/09/2026', '14/09/2026']), 'dmy')
  assert.equal(detectDateOrder(['09/14/2026']), 'mdy')
  assert.equal(parseScreenDate('14/09/2026', 'dmy'), '2026-09-14')
  assert.equal(parseScreenDate('09/14/2026', 'mdy'), '2026-09-14')
  assert.equal(parseScreenDate('2026-09-14'), '2026-09-14')
  assert.equal(parseScreenDate('14 sept. 2026'), '2026-09-14')
  assert.equal(parseScreenDate('Sep 14, 2026'), '2026-09-14')
  assert.equal(formatDateFor('aaaa-mm-jj', '2026-09-14'), '2026-09-14')
  assert.equal(formatDateFor('jj/mm/aaaa', '2026-09-14'), '14/09/2026')
  assert.equal(formatDateFor('mm/dd/yyyy', '2026-09-14'), '09/14/2026')
})

test('solde de fin : une carte attend le solde dû positif', () => {
  assert.equal(endingBalanceFor('card', -161.51), 161.51)
  assert.equal(endingBalanceFor('bank', 1200), 1200)
  assert.equal(endingBalanceFor('bank', null), null)
})

test('buildExpected : grand livre, déjà rapprochée dans QB, lignes sans lien', () => {
  const targets = [
    { id: 'a', txn_date: '2026-09-01', amount: 20000, qb_txn_id: '17960' },
    { id: 'b', txn_date: '2026-08-31', amount: -42, qb_txn_id: '17947' },
    { id: 'c', txn_date: '2026-08-10', amount: -99, qb_txn_id: null },
    { id: 'd', txn_date: '2026-09-05', amount: -7.5, qb_txn_id: null },
  ]
  const ledger = [
    { qbId: '17960', date: '2026-09-02', amount: 20000, cleared: 'C' },
    { qbId: '17947', date: '2026-08-31', amount: -42, cleared: 'R' },
    { qbId: '555', date: '2026-08-11', amount: -99, cleared: 'R' },
  ]
  const { expected, alreadyReconciled } = buildExpected(targets, ledger)
  assert.equal(alreadyReconciled, 2)
  assert.deepEqual(expected.map(e => [e.qbId, e.date, e.amount]), [['17960', '2026-09-02', 20000], [null, '2026-09-05', -7.5]])
})

test('matchScreen : id d’abord, puis montant + date, chaque ligne une fois, rien après la date de fin', () => {
  const expected = [
    { qbId: '17960', date: '2026-09-02', amount: 20000, borealIds: ['a'] },
    { qbId: null, date: '2026-09-05', amount: -7.5, borealIds: ['d'] },
    { qbId: null, date: '2026-09-06', amount: -7.5, borealIds: ['e'] },
    { qbId: null, date: '2026-09-10', amount: -300, borealIds: ['f'] },
  ]
  const screen = [
    { key: 1, date: '2026-09-03', amount: 20000, checked: false, ids: ['17960'] },
    { key: 2, date: '2026-09-05', amount: -7.5, checked: true, ids: [] },
    { key: 3, date: '2026-09-09', amount: -7.5, checked: false, ids: [] },
    { key: 4, date: '2026-09-12', amount: -50, checked: false, ids: [] },
    { key: 5, date: '2026-09-20', amount: -300, checked: false, ids: [] },
  ]
  const { matches, unmatchedScreen } = matchScreen(screen, expected, { endDate: '2026-09-14' })
  const byKey = Object.fromEntries(matches.map(m => [m.key, m.expectedIndex]))
  assert.equal(byKey[1], 0)
  assert.equal(byKey[2], 1)
  assert.equal(byKey[3], 2)
  assert.equal(byKey[5], undefined) // après la date de fin : jamais cochée
  assert.equal(matches.find(m => m.key === 2).checked, true) // déjà cochée : laissée telle quelle
  assert.deepEqual(unmatchedScreen.map(r => r.key), [4])
})

test('matchScreen : montant sans signe lisible → comparé en valeur absolue', () => {
  const expected = [{ qbId: null, date: '2026-09-05', amount: -12.34, borealIds: ['x'] }]
  const { matches } = matchScreen([{ key: 'r', date: '2026-09-05', amount: null, abs: 12.34, ids: [] }], expected)
  assert.equal(matches.length, 1)
})
