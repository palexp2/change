import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseHours, lastSlot, isDue, pickHours } from './autonomousAgents.js'

// 1er oct. 2026, 14 h 20 à Montréal (EDT, UTC-4).
const NOW = new Date('2026-10-01T18:20:00Z')

test('parseHours : JSON ou tableau, dédoublonné, trié, borné 0-23', () => {
  assert.deepEqual(parseHours('[15, 9, 9, 24, -1, "x"]'), [9, 15])
  assert.deepEqual(parseHours([3, 1]), [1, 3])
  assert.deepEqual(parseHours('pas du json'), [])
})

test('lastSlot : dernier créneau échu aujourd\'hui, sinon hier', () => {
  assert.equal(new Date(lastSlot([9, 14, 17], NOW)).toISOString(), '2026-10-01T18:00:00.000Z')
  // Avant le premier créneau du jour → dernier créneau de la veille.
  assert.equal(new Date(lastSlot([17], NOW)).toISOString(), '2026-09-30T21:00:00.000Z')
  assert.equal(lastSlot([], NOW), null)
})

test('isDue : actif, mission non vide, créneau récent jamais servi', () => {
  const base = { enabled: true, instructions: 'Inspecte X', run_hours: [14], created_at: '2026-09-01T00:00:00Z', last_run_at: null }
  assert.equal(isDue(base, NOW), true)
  assert.equal(isDue({ ...base, enabled: false }, NOW), false)
  assert.equal(isDue({ ...base, instructions: '  ' }, NOW), false)
  // Créneau déjà servi.
  assert.equal(isDue({ ...base, last_run_at: '2026-10-01T18:05:00Z' }, NOW), false)
  // Agent créé après le créneau : il attend le suivant.
  assert.equal(isDue({ ...base, created_at: '2026-10-01T18:10:00Z' }, NOW), false)
  // Créneau trop ancien (> 3 h) : pas de rattrapage.
  assert.equal(isDue({ ...base, run_hours: [9] }, NOW), false)
})

test('pickHours : N heures espacées, vers les heures calmes, sans chevaucher les autres agents', () => {
  assert.equal(pickHours(4).length, 4)
  assert.deepEqual(pickHours(24), Array.from({ length: 24 }, (_, h) => h))
  // Journée chargée de 8 h à 17 h → un seul passage, hors de cette plage.
  const load = Array.from({ length: 24 }, (_, h) => (h >= 8 && h <= 17 ? 10 : 0))
  assert.ok(pickHours(1, { load })[0] < 8)
  // Heure 0 déjà prise par un autre agent → décalée.
  assert.notDeepEqual(pickHours(2, { taken: [0] }), [0, 12])
})
