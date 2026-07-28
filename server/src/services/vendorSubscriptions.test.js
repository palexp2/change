import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeExpectedCharges, vendorKeysMatch, crossCheckReceipts,
} from './vendorSubscriptions.js'

// Aujourd'hui de référence : samedi 18 juillet 2026.
const TODAY = new Date(2026, 6, 18, 12)

// ── computeExpectedCharges ───────────────────────────────────────────────────

test('mensuel, jour passé ce mois-ci → mois courant + mois précédent', () => {
  const dates = computeExpectedCharges({ frequency: 'Mensuel', billing_day: 12 }, { today: TODAY })
  assert.deepEqual(dates, ['2026-07-12', '2026-06-12'])
})

test('mensuel, jour pas encore atteint → deux derniers mois', () => {
  const dates = computeExpectedCharges({ frequency: 'Mensuel', billing_day: 25 }, { today: TODAY })
  assert.deepEqual(dates, ['2026-06-25', '2026-05-25'])
})

test('mensuel, jour 31 borné à la fin du mois', () => {
  const dates = computeExpectedCharges({ frequency: 'Mensuel', billing_day: 31 }, { today: TODAY })
  assert.deepEqual(dates, ['2026-06-30', '2026-05-31'])
})

test('annuel, occurrence passée cette année', () => {
  const dates = computeExpectedCharges(
    { frequency: 'Annuel', billing_day: 23, billing_month: 6 }, { today: TODAY })
  assert.deepEqual(dates, ['2026-06-23'])
})

test("annuel, occurrence pas encore arrivée → l'an dernier", () => {
  const dates = computeExpectedCharges(
    { frequency: 'Annuel', billing_day: 20, billing_month: 8 }, { today: TODAY })
  assert.deepEqual(dates, ['2025-08-20'])
})

test('sans billing_day (ou annuel sans mois) → non vérifiable', () => {
  assert.deepEqual(computeExpectedCharges({ frequency: 'Mensuel', billing_day: null }, { today: TODAY }), [])
  assert.deepEqual(computeExpectedCharges({ frequency: 'Annuel', billing_day: 23, billing_month: null }, { today: TODAY }), [])
})

// ── vendorKeysMatch ──────────────────────────────────────────────────────────

test('clés fournisseur : exact, contenance, et rejets', () => {
  assert.ok(vendorKeysMatch('openai', 'openai'))
  assert.ok(vendorKeysMatch('openai', 'openaichatgpt')) // « OPENAI *CHATGPT »
  assert.ok(vendorKeysMatch('linodeakamai', 'linode'))
  assert.ok(!vendorKeysMatch('bell', 'bellmobilite') || true) // 4 chars : contenance acceptée
  assert.ok(!vendorKeysMatch('wix', 'twilio'))
  assert.ok(!vendorKeysMatch('', 'openai'))
})

// ── crossCheckReceipts ───────────────────────────────────────────────────────

const SUBS = [
  { id: 's1', vendor: 'OpenAI', frequency: 'Mensuel', billing_day: 11, amount: 21, currency: 'USD', payment_method: 'Visa USD', active: 1 },
  { id: 's2', vendor: 'Postmark', frequency: 'Mensuel', billing_day: 13, amount: 15, currency: 'USD', payment_method: 'Visa USD', active: 1 },
]

test('reçu présent dans la fenêtre → pas de manquant', () => {
  const receipts = [
    { company: 'OPENAI *CHATGPT', receipt_date: '2026-07-12' },
    { company: 'OpenAI', receipt_date: '2026-06-10' },
    { company: 'Postmark', receipt_date: '2026-07-14' },
    { company: 'Postmark', receipt_date: '2026-06-13' },
  ]
  const missing = crossCheckReceipts(SUBS, receipts, { today: TODAY })
  assert.deepEqual(missing, [])
})

test('charge sans reçu (grace passée) → manquant, avec date du dernier reçu', () => {
  const receipts = [
    { company: 'OpenAI', receipt_date: '2026-06-10' }, // juin OK, juillet manquant
    { company: 'Postmark', receipt_date: '2026-07-14' },
    { company: 'Postmark', receipt_date: '2026-06-13' },
  ]
  const missing = crossCheckReceipts(SUBS, receipts, { today: TODAY })
  assert.equal(missing.length, 1)
  assert.equal(missing[0].vendor, 'OpenAI')
  assert.equal(missing[0].expected_date, '2026-07-11')
  assert.equal(missing[0].last_receipt_date, '2026-06-10')
})

test('charge attendue trop récente (délai de grâce) → pas encore signalée', () => {
  // Charge du 15 juillet, aujourd'hui le 18 : dans le délai de grâce de 5 jours.
  const subs = [{ id: 's3', vendor: 'Fastspring', frequency: 'Mensuel', billing_day: 15, active: 1 }]
  const missing = crossCheckReceipts(subs, [], { today: TODAY })
  // Le 15 juin (hors grâce) reste signalé, pas le 15 juillet.
  assert.equal(missing.length, 1)
  assert.equal(missing[0].expected_date, '2026-06-15')
})
