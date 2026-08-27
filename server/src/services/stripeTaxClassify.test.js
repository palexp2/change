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

// Régression : une facture sans AUCUN tax_rate (automatic_tax désactivé sur
// l'abonnement Stripe) sortait avec qb_tax_code NULL — le filet « Détaxé » vivait
// à l'intérieur du bloc qui exige des tax_rates. Cas fondateur : 92E2BD27-0016
// (Way Farms, US-OH) sur le Deposit 17831 du 10 août 2026, ligne poussée sans
// TaxCodeRef, et EA8C6BB7-0003 (Ferme Quatre-Temps, QC) facturée sans TPS/TVQ.

const { resolveZeroTaxCode } = await import('./stripe.js')

test('Aucun tax_rate + client hors Canada → Détaxé (cas Way Farms US-OH)', () => {
  assert.equal(resolveZeroTaxCode({ taxDetails: [], country: 'US' }), '4')
})

test('tax_rate à 0 + client hors Canada → Détaxé (comportement historique préservé)', () => {
  assert.equal(resolveZeroTaxCode({ taxDetails: [{ tax_rate: 'txr_x', amount: 0 }], country: 'us' }), '4')
})

test('Aucun tax_rate + client canadien → null (anomalie, bloque le push auto)', () => {
  assert.equal(resolveZeroTaxCode({ taxDetails: [], country: 'CA' }), null)
})

test('Pays inconnu → Détaxé (pas de bruit sur les factures sans adresse)', () => {
  assert.equal(resolveZeroTaxCode({ taxDetails: [] }), '4')
})

test('Taxe réellement perçue → aucun code forcé', () => {
  assert.equal(resolveZeroTaxCode({ taxDetails: [{ amount: 425 }, { amount: 0 }], country: 'CA' }), null)
  assert.equal(resolveZeroTaxCode({ taxDetails: [{ amount: 425 }], country: 'US' }), null)
})
