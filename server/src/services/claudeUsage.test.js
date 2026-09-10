import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextRetryDelayMs, failureReasonForStatus } from './claudeUsage.js'

// ── Espacement des tentatives après un échec ──────────────────────────────────
// L'endpoint des quotas est limité en fréquence : un échec doit ESPACER les essais,
// jamais les rapprocher (c'était le bug — cache raccourci à 15 s après un 429, donc
// quatre fois plus d'appels sur l'endpoint qui venait de refouler).

test('l\'attente double à chaque échec, puis plafonne à 10 min', () => {
  assert.equal(nextRetryDelayMs(1), 30_000)
  assert.equal(nextRetryDelayMs(2), 60_000)
  assert.equal(nextRetryDelayMs(3), 120_000)
  assert.equal(nextRetryDelayMs(9), 600_000)
  assert.equal(nextRetryDelayMs(50), 600_000, 'plafond, pas de croissance infinie')
})

test('Retry-After ne sert qu\'à allonger l\'attente', () => {
  // Anthropic renvoie « Retry-After: 0 » avec ses 429 : le prendre au mot relancerait
  // la boucle d'appels qu'on veut casser.
  assert.equal(nextRetryDelayMs(1, 0), 30_000)
  assert.equal(nextRetryDelayMs(1, 5_000), 30_000)
  assert.equal(nextRetryDelayMs(1, 120_000), 120_000, 'le serveur demande plus : on obéit')
  assert.equal(nextRetryDelayMs(1, 3_600_000), 600_000, 'jamais au-delà du plafond')
  assert.equal(nextRetryDelayMs(1, NaN), 30_000, 'en-tête absent ou illisible')
})

// ── Ce qu'on dira à l'écran ───────────────────────────────────────────────────

test('la nature du refus est reconnue', () => {
  assert.equal(failureReasonForStatus(429), 'rate_limited')
  assert.equal(failureReasonForStatus(401), 'unauthorized')
  assert.equal(failureReasonForStatus(403), 'unauthorized')
  assert.equal(failureReasonForStatus(500), 'http_error')
})
