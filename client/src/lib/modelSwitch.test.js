// Exécution : `node --test client/src/lib/modelSwitch.test.js`
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { windowSlack, pickDefaultModel } from './modelSwitch.js'

const NOW = Date.parse('2026-09-22T12:00:00Z')
const inH = h => new Date(NOW + h * 3600000).toISOString()

const claude = (s, sH, w, wH) => ({
  subscriptionAvailable: true,
  session: { utilizationPct: s, resetsAt: inH(sH) },
  week: { utilizationPct: w, resetsAt: inH(wH) },
})
const codex = (s, sH, w, wH) => ({
  available: true,
  windows: [
    { key: 'primary', label: 'Fenêtre 5 h', utilizationPct: s, resetsAt: inH(sH) },
    { key: 'secondary', label: 'Semaine', utilizationPct: w, resetsAt: inH(wH) },
  ],
})

test('marge = part restante ÷ temps restant', () => {
  assert.equal(windowSlack({ utilizationPct: 50, resetsAt: inH(84) }, 7 * 24 * 60, NOW), 1)
  assert.equal(windowSlack({ utilizationPct: 98, resetsAt: inH(1) }, 300, NOW), 0)
  assert.equal(windowSlack({ utilizationPct: null }, 300, NOW), null)
})

test('semaine Claude presque finie avec du quota à perdre → Opus', () => {
  const r = pickDefaultModel({ ...claude(10, 4, 40, 6), codex: codex(10, 4, 50, 100) }, NOW)
  assert.equal(r.model, 'opus')
})

test('Claude en avance sur son rythme hebdo → Astra', () => {
  const r = pickDefaultModel({ ...claude(10, 4, 80, 120), codex: codex(10, 4, 30, 120) }, NOW)
  assert.equal(r.model, 'codex')
})

test('fenêtre de 5 h Codex épuisée → Opus', () => {
  const r = pickDefaultModel({ ...claude(60, 2, 60, 80), codex: codex(100, 2, 10, 150) }, NOW)
  assert.equal(r.model, 'opus')
})

test('égalité ou quotas illisibles → Astra', () => {
  assert.equal(pickDefaultModel({ ...claude(20, 4, 50, 84), codex: codex(20, 4, 50, 84) }, NOW).model, 'codex')
  assert.equal(pickDefaultModel({ subscriptionAvailable: false, codex: { available: false } }, NOW).model, 'codex')
})
