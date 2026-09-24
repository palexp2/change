import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeAiUsage } from './aiUsageSummary.js'

const now = Date.parse('2026-09-22T12:00:00Z')
const future = '2026-09-23T00:00:00Z'
const past = '2026-09-22T11:00:00Z'

test('aucun compte lisible → aucune ligne', () => {
  assert.deepEqual(summarizeAiUsage({ claude: null, codex: { available: false } }, now), { accounts: [] })
})

test('fenêtre périmée écartée, compte sans fenêtre absent', () => {
  const r = summarizeAiUsage({
    claude: { subscriptionAvailable: true, session: { utilizationPct: 40, resetsAt: past },
      week: { utilizationPct: 61, resetsAt: future }, weekScoped: { utilizationPct: 74, resetsAt: future, label: 'Fable' } },
    codex: { available: true, windows: [{ key: 'primary', label: 'Semaine', utilizationPct: 80, resetsAt: past }] },
  }, now)
  assert.equal(r.accounts.length, 1)
  assert.deepEqual(r.accounts[0].windows.map(w => [w.label, w.pct]), [['Semaine', 61], ['Semaine Fable', 74]])
})

test('codex : fenêtre hebdo seule, libellé de Travaux', () => {
  const r = summarizeAiUsage({ codex: { available: true, windows: [{ key: 'primary', label: 'Semaine', utilizationPct: 80, resetsAt: future }] } }, now)
  assert.deepEqual(r.accounts[0].windows, [{ key: 'primary', label: 'Semaine', pct: 80, resetsAt: future, severity: null }])
})
