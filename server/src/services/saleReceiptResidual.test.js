// Écart entre la somme des lignes extraites et le montant réellement facturé.
//
// Deux garde-fous, dans cet ordre :
//  1. ne pas FABRIQUER l'écart — un « fret » imprimé qui n'est pas une charge (valeur
//     déclarée en douane, port payé) ne se répartit pas sur les lignes ;
//  2. quand un écart subsiste malgré tout, la ligne qui le matérialise doit DIRE ce
//     qu'elle est : sens de l'écart et les deux montants comparés.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  reconcileDiscountFreightProrata, reconcileItemsResidual, residualLineDescription, amountDueHtBase,
} from './saleReceiptExtraction.js'

// Facture DigiKey 132580242 : 4 lignes = 165,99 $, TPS 8,30 $, total 174,29 $, et
// « Valeur de fret (port payé) 15,00 » — déclaration douanière, pas une charge.
const DIGIKEY = [
  { description: 'BATT HOLDER AA 3 CELL 6" LEADS', quantity: 10, unit_price: 2.766, total: 27.66 },
  { description: 'BATTERY ALKALINE 1.5V AA', quantity: 20, unit_price: 0.561, total: 11.22 },
  { description: 'HEAT SINK KIT FOR RASPBERRY PI 4', quantity: 30, unit_price: 1.55, total: 46.5 },
  { description: 'SBC 1.5GHZ 4 CORE 2GB PI 4 MOD B', quantity: 1, unit_price: 80.61, total: 80.61 },
]

test('fret déclaré (port payé) : les lignes retombent déjà sur la facture, on n’y touche pas', () => {
  const out = reconcileDiscountFreightProrata(DIGIKEY, { freight: 15, htBase: 165.99 })
  assert.equal(out, null)
  // …et rien ne reste à réconcilier : aucune ligne d’écart n’est créée.
  assert.equal(reconcileItemsResidual(DIGIKEY, 165.99), null)
})

test('fret réellement facturé : réparti au prorata (cas Scaled Instruments)', () => {
  const items = [{ description: 'Capteur', quantity: 1, unit_price: 1920, total: 1920 }]
  const out = reconcileDiscountFreightProrata(items, { freight: 134.24, htBase: 2054.24 })
  assert.equal(out.subtotal, 2054.24)
  assert.equal(out.items[0].total, 2054.24)
})

test('sans base HT connue, le comportement d’origine tient', () => {
  const out = reconcileDiscountFreightProrata(DIGIKEY, { freight: 15 })
  assert.equal(out.subtotal, 180.99)
})

test('la ligne d’écart dit le sens et les deux montants comparés', () => {
  const items = [{ description: 'Service', total: 100 }]
  const out = reconcileItemsResidual(items, 107.61)
  assert.equal(out.applied, true)
  assert.equal(out.delta, 7.61)
  assert.equal(out.items[2 - 1].description, 'Écart avec la facture, frais non détaillés — lignes 100,00 $ vs facture 107,61 $')
  assert.equal(out.items[1].total, 7.61)
})

test('lignes en trop : le sens de l’écart change', () => {
  assert.equal(
    residualLineDescription({ delta: -15, lineSum: 180.99, htBase: 165.99 }),
    'Écart avec la facture, lignes en trop — lignes 180,99 $ vs facture 165,99 $',
  )
})

test('écart de plus de 25 % : rien n’est rafistolé, l’extraction est signalée', () => {
  const out = reconcileItemsResidual([{ description: 'X', total: 10 }], 100)
  assert.equal(out.applied, false)
  assert.equal(out.delta, 90)
})

// PCBWay YR1808976 : lignes 556,33 $, transport 34,34 $, aucune taxe, total 590,67 $.
test('transport réel sans taxes : le montant dû arbitre, le fret est réparti', () => {
  const items = [
    { description: 'PCB', quantity: 5, unit_price: 1.692, total: 8.46 },
    { description: 'PCBA', quantity: 25, unit_price: 20.886, total: 522.15 },
    { description: 'Frais de traitement bancaire', total: 25.72 },
  ]
  const htBase = amountDueHtBase({ subtotal: 556.33, tps: 0, tvq: 0, other_taxes: 0, total: 590.67 })
  assert.equal(htBase, 590.67)
  const out = reconcileDiscountFreightProrata(items, { freight: 34.34, htBase })
  assert.equal(out.subtotal, 590.67)
  assert.equal(Math.round(out.items.reduce((s, it) => s + it.total, 0) * 100) / 100, 590.67)
})

test('port payé DigiKey : le montant dû exclut le fret, rien n’est réparti', () => {
  const htBase = amountDueHtBase({ subtotal: 165.99, tps: 8.3, tvq: 0, other_taxes: 0, total: 174.29 })
  assert.equal(reconcileDiscountFreightProrata(DIGIKEY, { freight: 15, htBase }), null)
})
