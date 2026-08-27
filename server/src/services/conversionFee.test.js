// Frais de conversion au push QB : quand le montant réellement passé à la banque
// diffère du total de la facture (AWS : facture USD, carte chargée en CAD puis
// reconvertie par Desjardins à son propre taux), l'écart s'ajoute en ligne
// « Frais de conversion » (code Exonéré). computeConversionFee est le calcul pur :
// fee = banque − facture, avec garde-fou anti-typo (écart > max(2 $, 10 %) refusé).

import test from 'node:test'
import assert from 'node:assert/strict'

import { computeConversionFee } from './quickbooks.js'

test('aucun montant fourni → pas de frais, pas d\'erreur', () => {
  assert.deepEqual(computeConversionFee(undefined, 72.08), { fee: 0, error: null })
  assert.deepEqual(computeConversionFee(null, 72.08), { fee: 0, error: null })
  assert.deepEqual(computeConversionFee('', 72.08), { fee: 0, error: null })
})

test('cas AWS août 2026 : banque 73,38 vs facture 72,08 → +1,30', () => {
  assert.deepEqual(computeConversionFee(73.38, 72.08), { fee: 1.3, error: null })
})

test('cas AWS juin 2026 : banque 71,06 vs facture 70,66 → +0,40', () => {
  assert.deepEqual(computeConversionFee(71.06, 70.66), { fee: 0.4, error: null })
})

test('montant banque égal au total → fee 0 (aucune ligne à créer)', () => {
  assert.deepEqual(computeConversionFee(72.08, 72.08), { fee: 0, error: null })
  // tolérance sous le cent
  assert.deepEqual(computeConversionFee(72.082, 72.08), { fee: 0, error: null })
})

test('banque légèrement inférieure à la facture → frais négatif accepté', () => {
  assert.deepEqual(computeConversionFee(71.5, 72.08), { fee: -0.58, error: null })
})

test('montant sous forme de chaîne accepté (champ de formulaire)', () => {
  assert.deepEqual(computeConversionFee('73.38', 72.08), { fee: 1.3, error: null })
})

test('garde-fou : écart > 10 % refusé (typo probable)', () => {
  const r = computeConversionFee(102.73, 72.08) // total CAD saisi par erreur dans le champ USD
  assert.equal(r.fee, 0)
  assert.match(r.error, /trop grand/i)
})

test('garde-fou : plancher de 2 $ sur les petites factures (historique AWS ~8 $)', () => {
  // 0,28 d'écart sur 8,60 = 3,3 % — au-delà de 10 % mais sous le plancher de 2 $ : accepté.
  assert.deepEqual(computeConversionFee(8.88, 8.6), { fee: 0.28, error: null })
})

test('montant invalide ou négatif → erreur', () => {
  assert.match(computeConversionFee('abc', 72.08).error, /invalide/i)
  assert.match(computeConversionFee(-5, 72.08).error, /invalide/i)
  assert.match(computeConversionFee(0, 72.08).error, /invalide/i)
})
