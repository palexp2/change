// Codes de taxe QB à récupération PARTIELLE (« TPS/TVQ repas », CTI/RTI 50 %).
// Cas de référence — reçu Matto : repas 56,00 HT, TPS 2,80, TVQ 5,59 (addition 64,39),
// pourboire 10,08 hors champ, débité 74,47. QB doit porter 60,20 au compte de dépense
// (56 + la moitié NON récupérable des taxes) et calculer 4,19 de taxe récupérable.

import test from 'node:test'
import assert from 'node:assert/strict'

const { solvePartialRecoveryBase, rescaleAmountsToSum, aggregateLineTaxLines } = await import('./quickbooks.js')

// Taux d'achat réels du code « TPS/TVQ repas » dans le fichier QB d'Orisha.
const MEAL_RATES = [2.3259, 4.64007]

test('base résolue pour que base + taxe QB = montant payé du repas', () => {
  const base = solvePartialRecoveryBase(64.39, MEAL_RATES)
  assert.equal(base, 60.20)
  const tax = MEAL_RATES.reduce((s, p) => s + Math.round(base * p) / 100, 0)
  assert.equal(Math.round(tax * 100) / 100, 4.19)
  assert.equal(Math.round((base + 4.19) * 100) / 100, 64.39)
})

test('code au taux plein → la base reste le HT (aucune majoration)', () => {
  // 56 HT + 14,975 % = 64,39 : la base résolue doit revenir au HT.
  assert.equal(solvePartialRecoveryBase(64.39, [5, 9.975]), 56)
})

test('code à 0 % ou brut nul → brut inchangé', () => {
  assert.equal(solvePartialRecoveryBase(10.08, []), 10.08)
  assert.equal(solvePartialRecoveryBase(0, MEAL_RATES), 0)
})

test('répartition de la base majorée sur les lignes, au cent près', () => {
  const scaled = rescaleAmountsToSum([27, 29], 60.20)
  assert.equal(scaled.reduce((s, a) => s + a, 0), 60.20)
  assert.deepEqual(scaled, [29.03, 31.17])
})

test('total de la transaction = repas majoré + pourboire + taxe récupérable', () => {
  const lines = [
    { amount: 29.03, taxCodeId: '15' },
    { amount: 31.17, taxCodeId: '15' },
    { amount: 10.08, taxCodeId: '2' },
  ]
  const rates = new Map([
    ['15', MEAL_RATES.map((p, i) => ({ id: `r${i}`, percent: p }))],
    ['2', []],
  ])
  const { totalTax } = aggregateLineTaxLines(lines, rates)
  assert.equal(totalTax, 4.19)
  const linesSum = lines.reduce((s, l) => s + l.amount, 0)
  assert.equal(Math.round((linesSum + totalTax) * 100) / 100, 74.47)
})
