// Tests pour proRateRefundTax — proratisation de la taxe d'un remboursement au
// brut effectivement remboursé.
//
// Contexte : un refund partiel héritait de 100 % de la taxe de la facture
// d'origine (bug payout po_1TcF3rEO122sMsbJQ1Bl5wao → Deposit 17431, juin 2026).
// Un refund de 730 $ sur une facture de 4805,96 $ TTC portait 625,96 $ de taxe
// (la taxe TOTALE de la facture) au lieu de sa part proratisée (~95 $), ce qui
// déversait 610,38 $ dans la ligne « Ajustement d'arrondi taxes » du Deposit QB.

import test from 'node:test'
import assert from 'node:assert/strict'

import { proRateRefundTax } from './stripe.js'

test('refund complet → taxe pleine (ratio 1)', () => {
  // Facture 4805,96 TTC, refund de la totalité.
  assert.equal(proRateRefundTax(209, 4805.96, 4805.96), 209)
  assert.equal(proRateRefundTax(416.96, 4805.96, 4805.96), 416.96)
})

test('refund partiel → taxe proratisée (cas régression Deposit 17431)', () => {
  // Refund 730 $ sur facture 4805,96 $ TTC → ratio 0,15189.
  // TPS 209 × ratio ≈ 31,75 ; TVQ 416,96 × ratio ≈ 63,33 ; total ≈ 95,08.
  const gst = proRateRefundTax(209, 730, 4805.96)
  const qst = proRateRefundTax(416.96, 730, 4805.96)
  assert.equal(gst, 31.75)
  assert.equal(qst, 63.33)
  // La somme proratisée doit être cohérente avec le brut remboursé : HT du refund
  // = 730 − 95,08 = 634,92, ce que QB recalcule à 14,975 % sans laisser de gros
  // résidu (l'écart de 610 $ disparaît).
  const ht = 730 - (gst + qst)
  assert.ok(Math.abs(ht * 1.14975 - 730) < 0.1, `HT*1,14975 (${(ht * 1.14975).toFixed(2)}) doit ≈ 730`)
})

test('taxe nulle → 0 (aucune taxe sur la facture)', () => {
  assert.equal(proRateRefundTax(0, 730, 4805.96), 0)
})

test('total facture indisponible → comportement legacy (taxe pleine)', () => {
  // Sans invoice.total fiable, on retombe sur la taxe pleine (correct pour un
  // refund complet, conservateur sinon — ne casse pas l'ancien comportement).
  assert.equal(proRateRefundTax(209, 730, 0), 209)
  assert.equal(proRateRefundTax(209, 730, null), 209)
  assert.equal(proRateRefundTax(209, 730, undefined), 209)
})

test('refund > total facture → ratio plafonné à 1 (pas de sur-taxe)', () => {
  // Garde-fou : un brut remboursé supérieur au total facture (données aberrantes)
  // ne doit jamais produire une taxe supérieure à la taxe pleine.
  assert.equal(proRateRefundTax(209, 9999, 4805.96), 209)
})
