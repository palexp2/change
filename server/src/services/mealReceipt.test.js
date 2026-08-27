// Reçus de repas : le pourboire est hors champ (jamais taxé) et le repas à
// « TPS/TVQ repas ». Cas de référence : addition Matto 56,00 + 2,80 + 5,59 = 64,39,
// pourboire 10,08 sur le coupon du terminal → montant débité 74,47.

import test from 'node:test'
import assert from 'node:assert/strict'
import { applyMealTaxCodeNames, reconcileMealAmounts, isTipLine } from './mealReceipt.js'

test('isTipLine reconnaît les libellés de pourboire, pas les plats', () => {
  for (const d of ['Pourboire', 'POURBOIRE', 'Tip', 'Gratuity', 'Frais de service']) {
    assert.equal(isTipLine(d), true, d)
  }
  for (const d of ['1 Poisson midi', 'Viande midi', '', null]) {
    assert.equal(isTipLine(d), false, String(d))
  }
})

test('codes par ligne : pourboire hors champ, repas TPS/TVQ repas', () => {
  const { items, applied } = applyMealTaxCodeNames([
    { description: '1 Poisson midi', total: 27 },
    { description: '1 Viande midi', total: 29 },
    { description: 'Pourboire', total: 10.08 },
  ])
  assert.equal(applied, 3)
  assert.deepEqual(items.map(i => i.tax_code_name), ['TPS/TVQ repas', 'TPS/TVQ repas', 'Hors champ'])
})

test('une ligne déjà codée à la main n’est pas écrasée', () => {
  const { items, applied } = applyMealTaxCodeNames([
    { description: 'Repas', total: 56, tax_code_id: '8' },
    { description: 'Pourboire', total: 10 },
  ])
  assert.equal(applied, 1)
  assert.equal(items[0].tax_code_name, undefined)
  assert.equal(items[1].tax_code_name, 'Hors champ')
})

test('total recalé sur le montant débité (addition + pourboire), taxes inchangées', () => {
  const fixed = reconcileMealAmounts({
    items: [
      { description: '1 Poisson midi', total: 27 },
      { description: '1 Viande midi', total: 29 },
      { description: 'Pourboire', total: 10.08 },
    ],
    subtotal: 56, tps: 2.8, tvq: 5.59, other_taxes: 0, total: 64.39,
  })
  assert.deepEqual(fixed, { subtotal: 66.08, total: 74.47 })
})

test('aucun pourboire → aucune correction', () => {
  assert.equal(reconcileMealAmounts({
    items: [{ description: 'Repas', total: 56 }],
    subtotal: 56, tps: 2.8, tvq: 5.59, other_taxes: 0, total: 64.39,
  }), null)
})

test('invariant déjà exact → aucune correction', () => {
  assert.equal(reconcileMealAmounts({
    items: [{ description: 'Repas', total: 56 }, { description: 'Pourboire', total: 10.08 }],
    subtotal: 66.08, tps: 2.8, tvq: 5.59, other_taxes: 0, total: 74.47,
  }), null)
})
