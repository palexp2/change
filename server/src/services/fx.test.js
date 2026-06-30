// Borne de fraîcheur du fallback FX. getUsdCadRate retombait sur le dernier taux
// USD→CAD en cache « regardless of distance » quand la Banque du Canada était
// indisponible : un taux vieux de plusieurs jours produisait des montants CAD/USD
// inexacts sur les Deposits QuickBooks, sans signal. isFreshFallbackRate borne
// l'âge accepté pour rendre l'erreur visible au lieu de la propager dans la compta.

import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'
import assert from 'node:assert/strict'

// Évite d'ouvrir la vraie DB au chargement de db/database.js.
process.env.DATABASE_PATH = join(tmpdir(), `erp-test-fx-${process.pid}.db`)

const { isFreshFallbackRate, fxRateAgeDays } = await import('./fx.js')

test('fxRateAgeDays — écart en jours, absolu', () => {
  assert.equal(fxRateAgeDays('2026-06-20', '2026-06-20'), 0)
  assert.equal(fxRateAgeDays('2026-06-13', '2026-06-20'), 7)
  // Symétrique : peu importe le sens (taux après la date cible).
  assert.equal(fxRateAgeDays('2026-06-27', '2026-06-20'), 7)
})

test('taux du jour même — frais', () => {
  assert.equal(isFreshFallbackRate('2026-06-20', '2026-06-20'), true)
})

test('taux à 5 jours (long week-end + férié) — encore frais', () => {
  assert.equal(isFreshFallbackRate('2026-06-15', '2026-06-20'), true)
})

test('taux pile à la borne (7 j) — accepté (<=)', () => {
  assert.equal(isFreshFallbackRate('2026-06-13', '2026-06-20'), true)
})

test('taux à 8 jours — rejeté (au-delà de la borne)', () => {
  assert.equal(isFreshFallbackRate('2026-06-12', '2026-06-20'), false)
})

test('taux vieux de plusieurs semaines — rejeté', () => {
  assert.equal(isFreshFallbackRate('2026-05-20', '2026-06-20'), false)
})

test('aucune observation en cache (rateDate falsy) — rejeté', () => {
  assert.equal(isFreshFallbackRate(null, '2026-06-20'), false)
  assert.equal(isFreshFallbackRate(undefined, '2026-06-20'), false)
})

test('borne configurable — maxAgeDays explicite respecté', () => {
  // Avec une borne de 2 jours, un taux de 5 jours est rejeté…
  assert.equal(isFreshFallbackRate('2026-06-15', '2026-06-20', 2), false)
  // …et un taux de 1 jour reste accepté.
  assert.equal(isFreshFallbackRate('2026-06-19', '2026-06-20', 2), true)
})
