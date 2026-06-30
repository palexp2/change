// Régression : classifyTaxRate doit ventiler les TVH provinciales mono-taux (ON 13 %,
// Maritimes 15 %) même quand le libellé Stripe ne contient aucun mot-clé HST/TVH
// (observé : « Sales tax 13% ON », tax_rate txr_1QcAx2EO122sMsbJyCDv5EXR).
//
// Avant le fix, classifyTaxRate renvoyait null → invoice_tax_gst/qst restaient à 0 →
// buildDepositFromPayout ne soustrayait pas la taxe du HT → QB recalculait 13 % par-dessus
// le brut → ligne « Ajustement d'arrondi taxes » de ~1505 $ sur le payout
// po_1Tjq87EO122sMsbJA7yWrG0Z (Deposit 17561, juin 2026).

import test from 'node:test'
import assert from 'node:assert/strict'

const { classifyTaxRate } = await import('./stripe.js')

test('TVH Ontario 13 % au libellé « Sales tax 13% ON » → gst (cas régression Deposit 17561)', () => {
  assert.equal(classifyTaxRate({ display_name: 'Sales tax', description: '13% ON', percentage: 13 }), 'gst')
})

test('TVH Maritimes 15 % sans mot-clé → gst', () => {
  assert.equal(classifyTaxRate({ display_name: 'Sales tax', percentage: 15 }), 'gst')
})

test('Mot-clé explicite prime toujours sur le pourcentage', () => {
  assert.equal(classifyTaxRate({ display_name: 'HST 13%', percentage: 13 }), 'gst')
  assert.equal(classifyTaxRate({ display_name: 'TVQ', percentage: 9.975 }), 'qst')
})

test('TPS 5 % et TVQ 9.975 % conservent leur classification', () => {
  assert.equal(classifyTaxRate({ display_name: 'Sales tax 5%', percentage: 5 }), 'gst')
  assert.equal(classifyTaxRate({ description: '9.975%', percentage: 9.975 }), 'qst')
})

test('Taux inconnu non harmonisé → null (pas de faux positif)', () => {
  assert.equal(classifyTaxRate({ display_name: 'PST BC', percentage: 7 }), null)
  assert.equal(classifyTaxRate(null), null)
})
