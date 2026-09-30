import test from 'node:test'
import assert from 'node:assert'
import { balanceVerdict, reauthVerdict, humanDuration } from './plaidBalanceAlert.js'

const now = Date.parse('2026-09-29T20:00:00Z')

test('solde relu il y a moins que le seuil : rien à signaler', () => {
  const v = balanceVerdict({ read_at: '2026-09-29T17:30:00Z', balance: 131472.78 }, { staleHours: 8, now })
  assert.equal(v.alert, false)
})

test('solde figé au-delà du seuil : alerte, avec l\'âge et le montant', () => {
  const v = balanceVerdict({ read_at: '2026-09-27T20:00:00Z', balance: 131472.78 }, { staleHours: 8, now })
  assert.equal(v.alert, true)
  assert.equal(v.kind, 'stale')
  assert.equal(Math.round(v.hours), 48)
  assert.equal(v.balance, 131472.78)
})

test('aucun solde jamais lu : alerte aussi', () => {
  assert.equal(balanceVerdict(null, { staleHours: 8, now }).kind, 'jamais')
})

test('autorisation expirée : alerte ; état illisible : non', () => {
  assert.equal(reauthVerdict({ needs_reauth: true, institution_name: 'BNC' }).alert, true)
  assert.equal(reauthVerdict({ health_error: 'timeout' }).alert, false)
  assert.equal(reauthVerdict({ needs_reauth: false }).alert, false)
})

test('durées en mots', () => {
  assert.equal(humanDuration(9.4), '9 h')
  assert.equal(humanDuration(72), '3 jours')
})
