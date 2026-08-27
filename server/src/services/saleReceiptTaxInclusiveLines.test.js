// Lignes imprimées TAXES INCLUSES (Bell Mobilité, Amazon…) : l'extraction doit les
// ramener à la base HT, sinon la fiche dérive un total = lignes + taxes qui compte la
// taxe deux fois (Bell août 2026 : 222,46 $ au lieu de 196,83 $).

import test from 'node:test'
import assert from 'node:assert/strict'

const { normalizeTaxInclusiveLines } = await import('./saleReceiptExtraction.js')

test('Bell Mobilité — 4 lignes taxes incluses ramenées au HT, total préservé', () => {
  const out = normalizeTaxInclusiveLines({
    items: [
      { description: '418-998-9189', quantity: 1, unit_price: 47.77, total: 47.77 },
      { description: '581-578-5802', quantity: 1, unit_price: 47.77, total: 47.77 },
      { description: '581-849-3145', quantity: 1, unit_price: 47.77, total: 47.77 },
      { description: '581-991-8915', quantity: 1, unit_price: 53.52, total: 53.52 },
    ],
    subtotal: 196.83, tps: 8.57, tvq: 17.06, other_taxes: 0, total: 196.83,
  })
  assert.ok(out)
  assert.equal(out.subtotal, 171.20)
  const sum = Math.round(out.items.reduce((s, it) => s + it.total, 0) * 100) / 100
  assert.equal(sum, 171.20)
  assert.equal(Math.round((sum + 8.57 + 17.06) * 100) / 100, 196.83)
  // unit_price recalé sur le nouveau montant de ligne (quantité 1).
  assert.equal(out.items[0].unit_price, out.items[0].total)
  assert.equal(out.items[0].description, '418-998-9189')
})

test('facture normale (lignes HT) — aucune correction', () => {
  assert.equal(normalizeTaxInclusiveLines({
    items: [{ description: 'Frais mensuels', total: 171.20 }],
    subtotal: 171.20, tps: 8.57, tvq: 17.06, other_taxes: 0, total: 196.83,
  }), null)
})

test('sans ligne chiffrée — seul le sous-total TTC est ramené au HT', () => {
  const out = normalizeTaxInclusiveLines({
    items: [{ description: 'Achat', total: null }],
    subtotal: 11.19, tps: 0.49, tvq: 0.97, other_taxes: 0, total: 11.19,
  })
  assert.ok(out)
  assert.equal(out.subtotal, 9.73)
})

test('reçu sans taxe — jamais touché', () => {
  assert.equal(normalizeTaxInclusiveLines({
    items: [{ description: 'Détaxé', total: 100 }],
    subtotal: 100, tps: 0, tvq: 0, other_taxes: 0, total: 100,
  }), null)
})

test('repas avec pourboire (lignes HT + pourboire) — non touché', () => {
  // plats 56,00 + pourboire 10,08 = sous-total 66,08 ; taxes 8,39 ; total 74,47
  assert.equal(normalizeTaxInclusiveLines({
    items: [{ description: 'Plats', total: 56.00 }, { description: 'Pourboire', total: 10.08 }],
    subtotal: 66.08, tps: 2.80, tvq: 5.59, other_taxes: 0, total: 74.47,
  }), null)
})

// ── Lignes incomplètes : la somme des articles doit retomber sur la base HT ──────
const { itemsImbalance, printedHtBase, reconcileItemsResidual } = await import('./saleReceiptExtraction.js')

test('Bell — 911 taxe municipale oubliée : écart détecté puis matérialisé en ligne', () => {
  const extracted = {
    items: [{ description: 'Frais mensuels', total: 78 }, { description: 'Remise', total: -25 },
      { description: 'Remise prix', total: -12 }],
    subtotal: 43.20, tps: 2.16, tvq: 4.31, other_taxes: 0, total: 49.67,
  }
  assert.equal(printedHtBase(extracted), 43.20)
  assert.equal(itemsImbalance(extracted), 2.20)
  const fixed = reconcileItemsResidual(extracted.items, 43.20)
  assert.equal(fixed.applied, true)
  assert.equal(Math.round(fixed.items.reduce((s, it) => s + it.total, 0) * 100) / 100, 43.20)
})

test('lignes qui bouclent — aucun écart, aucune ligne ajoutée', () => {
  const extracted = { items: [{ description: 'Frais', total: 171.20 }], subtotal: 171.20, tps: 8.57, tvq: 17.06, total: 196.83 }
  assert.equal(itemsImbalance(extracted), 0)
  assert.equal(reconcileItemsResidual(extracted.items, 171.20), null)
})

test('lignes taxes incluses — laissées au normaliseur dédié, pas à la réconciliation', () => {
  assert.equal(itemsImbalance({
    items: [{ description: 'a', total: 196.83 }], subtotal: 196.83, tps: 8.57, tvq: 17.06, total: 196.83,
  }), 0)
})

test('facture de transport (shipments) — non concernée', () => {
  assert.equal(itemsImbalance({
    shipments: [{ total: 100 }], items: [{ description: 'a', total: 10 }],
    subtotal: 100, tps: 5, tvq: 9.98, total: 114.98,
  }), 0)
})

test('écart énorme (>25 %) — pas de ligne inventée', () => {
  const out = reconcileItemsResidual([{ description: 'a', total: 10 }], 100)
  assert.equal(out.applied, false)
})
