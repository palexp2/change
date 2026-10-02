import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accountMargin, markAccountLimited, accountLimitedUntil } from './claudeAccounts.js'

test('la marge d\'un compte = son plafond le plus serré, seuil déduit', () => {
  const u = { session: { utilizationPct: 20 }, week: { utilizationPct: 70 } }
  assert.equal(accountMargin(u), 30)
  assert.equal(accountMargin(u, { session: 10, week: 20 }), 10)
  assert.equal(accountMargin({ session: {}, week: {} }), null, 'sans chiffre, pas de marge inventée')
})

test('un compte à sec le reste jusqu\'à sa réinitialisation', () => {
  const now = Date.now()
  markAccountLimited('test-x', now + 60_000)
  assert.equal(accountLimitedUntil('test-x', now), now + 60_000)
  assert.equal(accountLimitedUntil('test-x', now + 61_000), null)
})
