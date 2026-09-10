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

const { isFreshFallbackRate, fxRateAgeDays, usdCadRateLookup } = await import('./fx.js')
const { default: db } = await import('../db/database.js')

db.exec(`CREATE TABLE IF NOT EXISTS fx_rates (pair TEXT, date TEXT, rate REAL, PRIMARY KEY (pair, date))`)

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

// Lookup synchrone (affichage) : ne fait aucun appel réseau et retombe sur le
// jour ouvré précédent — c'est ce qui alimente la colonne « Montant (CAD) » de
// la page Paiements pour les lignes USD sans conversion mémorisée.
test('usdCadRateLookup — taux exact, jour ouvré précédent, hors cache', () => {
  db.prepare('DELETE FROM fx_rates').run()
  const ins = db.prepare('INSERT INTO fx_rates (pair, date, rate) VALUES (?, ?, ?)')
  ins.run('USDCAD', '2026-06-18', 1.35)
  ins.run('USDCAD', '2026-06-19', 1.36)

  const rateAt = usdCadRateLookup()
  assert.equal(rateAt('2026-06-19'), 1.36)
  // Samedi/dimanche → dernier taux publié.
  assert.equal(rateAt('2026-06-21T14:00:00Z'), 1.36)
  // Date antérieure au cache → plus ancien taux connu (valeur indicative).
  assert.equal(rateAt('2026-01-05'), 1.35)
  assert.equal(rateAt(null), null)
})

test('usdCadRateLookup — cache vide → null (pas de conversion inventée)', () => {
  db.prepare('DELETE FROM fx_rates').run()
  assert.equal(usdCadRateLookup()('2026-06-19'), null)
})
