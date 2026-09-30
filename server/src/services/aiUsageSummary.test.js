import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeAiUsage } from './aiUsageSummary.js'

const now = Date.parse('2026-09-22T12:00:00Z')
const future = '2026-09-23T00:00:00Z'
const past = '2026-09-22T11:00:00Z'

test('aucun compte lisible → aucune ligne', () => {
  assert.deepEqual(summarizeAiUsage({ claude: null }, now), { accounts: [] })
})

test('fenêtre périmée écartée, compte sans fenêtre absent', () => {
  const r = summarizeAiUsage({
    claude: { subscriptionAvailable: true, session: { utilizationPct: 40, resetsAt: past },
      week: { utilizationPct: 61, resetsAt: future } },
  }, now)
  assert.equal(r.accounts.length, 1)
  assert.deepEqual(r.accounts[0].windows.map(w => [w.label, w.pct]), [['Semaine', 61]])
})
