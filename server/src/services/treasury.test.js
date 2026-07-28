import { test } from 'node:test'
import assert from 'node:assert/strict'
import { expandRecurring, buildProjection, variableOccurrence, actionWindowStats } from './treasury.js'

// ── expandRecurring ──────────────────────────────────────────────────────────

test('monthly : chaque mois au jour donné, borné à la fin du mois', () => {
  assert.deepEqual(
    expandRecurring({ frequency: 'monthly', day_of_month: 1 }, '2026-07-18', '2026-08-31'),
    ['2026-08-01'])
  assert.deepEqual(
    expandRecurring({ frequency: 'monthly', day_of_month: 31 }, '2026-09-01', '2026-09-30'),
    ['2026-09-30'])
})

test('biweekly : cadence 14 jours alignée sur anchor_date', () => {
  // Paie ancrée mardi 21/07 → 21/07, 04/08, 18/08 dans la fenêtre.
  assert.deepEqual(
    expandRecurring({ frequency: 'biweekly', anchor_date: '2026-07-21' }, '2026-07-18', '2026-08-20'),
    ['2026-07-21', '2026-08-04', '2026-08-18'])
  // Anchor dans le passé lointain : l'alignement reste correct.
  assert.deepEqual(
    expandRecurring({ frequency: 'biweekly', anchor_date: '2026-06-09' }, '2026-07-18', '2026-08-05'),
    ['2026-07-21', '2026-08-04'])
})

test('weekly et quarterly', () => {
  assert.deepEqual(
    expandRecurring({ frequency: 'weekly', anchor_date: '2026-07-21' }, '2026-07-20', '2026-08-04'),
    ['2026-07-21', '2026-07-28', '2026-08-04'])
  assert.deepEqual(
    expandRecurring({ frequency: 'quarterly', anchor_date: '2026-01-15' }, '2026-07-01', '2026-12-31'),
    ['2026-07-15', '2026-10-15'])
})

test('récurrence sans ancre/jour → aucune occurrence', () => {
  assert.deepEqual(expandRecurring({ frequency: 'monthly', day_of_month: null }, '2026-07-01', '2026-08-01'), [])
  assert.deepEqual(expandRecurring({ frequency: 'biweekly', anchor_date: null }, '2026-07-01', '2026-08-01'), [])
})

// ── variableOccurrence ───────────────────────────────────────────────────────
// Montant variable (relevé Mastercard) : ne s'applique qu'à la première
// occurrence suivant la saisie, puis doit être ressaisi.

test('variable : le montant saisi ne vaut que pour la prochaine occurrence', () => {
  const r = { frequency: 'monthly', day_of_month: 5, variable_amount: 1, amount: 1200 }
  // Saisi le 2 juillet → s'applique au 5 juillet (projection démarrant avant).
  assert.equal(
    variableOccurrence({ ...r, amount_entered_at: '2026-07-02T14:00:00.000Z' }, '2026-07-01', '2026-08-31'),
    '2026-07-05')
  // Saisi le 10 juillet (après le 5) → s'applique au 5 août.
  assert.equal(
    variableOccurrence({ ...r, amount_entered_at: '2026-07-10T14:00:00.000Z' }, '2026-07-11', '2026-08-31'),
    '2026-08-05')
  // Saisi le jour même de l'occurrence → s'applique ce jour-là.
  assert.equal(
    variableOccurrence({ ...r, amount_entered_at: '2026-07-05T09:00:00.000Z' }, '2026-07-05', '2026-08-31'),
    '2026-07-05')
})

test('variable : montant périmé (occurrence passée) ou jamais saisi → null', () => {
  const r = { frequency: 'monthly', day_of_month: 5, variable_amount: 1, amount: 1200 }
  // Saisi le 2 juillet pour le 5 juillet, mais on projette à partir du 6 :
  // l'occurrence est passée, le montant ne se reporte PAS au 5 août.
  assert.equal(
    variableOccurrence({ ...r, amount_entered_at: '2026-07-02T14:00:00.000Z' }, '2026-07-06', '2026-08-31'),
    null)
  // Jamais saisi.
  assert.equal(variableOccurrence({ ...r, amount_entered_at: null }, '2026-07-01', '2026-08-31'), null)
  // Occurrence au-delà de la fenêtre de projection.
  assert.equal(
    variableOccurrence({ ...r, amount_entered_at: '2026-07-10T14:00:00.000Z' }, '2026-07-11', '2026-07-31'),
    null)
})

// ── actionWindowStats ────────────────────────────────────────────────────────
// La trésorerie est gérée au fur et à mesure : l'alerte et le virement suggéré
// ne regardent que la fenêtre d'action, pas le point bas plein horizon.

test('fenêtre d\'action : point bas et virement calculés sur les N premiers jours', () => {
  const days = [
    { date: '2026-07-21', balance: 19544 },
    { date: '2026-07-22', balance: 10670 },
    { date: '2026-07-23', balance: 2100 },   // sous le seuil, dans la fenêtre
    { date: '2026-07-24', balance: 4800 },
    { date: '2026-07-25', balance: -90000 }, // point bas lointain, HORS fenêtre
  ]
  const aw = actionWindowStats(days, 3, 5000)
  assert.equal(aw.min_balance, 2100)
  assert.equal(aw.min_date, '2026-07-23')
  // 5000 − 2100 = 2900 → arrondi au 1000 supérieur.
  assert.equal(aw.suggested_transfer, 3000)
  // Le −90 000 hors fenêtre n'influence ni le point bas ni le virement.
  const awFull = actionWindowStats(days, 10, 5000)
  assert.equal(awFull.min_balance, -90000)
  assert.equal(awFull.suggested_transfer, 95000)
})

test('fenêtre d\'action : aucun virement si le point bas reste au-dessus du seuil', () => {
  const days = [
    { date: '2026-07-21', balance: 19544 },
    { date: '2026-07-22', balance: 8000 },
  ]
  const aw = actionWindowStats(days, 14, 5000)
  assert.equal(aw.min_balance, 8000)
  assert.equal(aw.suggested_transfer, 0)
})

// ── buildProjection ──────────────────────────────────────────────────────────

test('projection : solde courant, point bas et événements groupés par jour', () => {
  const { days, min_balance, min_date } = buildProjection({
    startBalance: 10000,
    fromIso: '2026-07-18',
    toIso: '2026-07-22',
    events: [
      { date: '2026-07-20', amount: -8000, label: 'Dette', kind: 'recurring' },
      { date: '2026-07-21', amount: 12000, label: 'Payout Stripe', kind: 'payout' },
      { date: '2026-07-21', amount: -25000, label: 'Paie', kind: 'recurring' },
      { date: '2026-07-30', amount: -999, label: 'hors fenêtre', kind: 'bill' },
    ],
  })
  assert.equal(days.length, 5)
  assert.equal(days[0].balance, 10000)
  assert.equal(days[2].balance, 2000)       // 20/07 : −8000
  assert.equal(days[3].balance, -11000)     // 21/07 : +12000 −25000
  assert.equal(days[3].events.length, 2)
  assert.equal(min_balance, -11000)
  assert.equal(min_date, '2026-07-21')
  // L'événement hors fenêtre est ignoré.
  assert.ok(days.every(d => d.events.every(e => e.label !== 'hors fenêtre')))
})
