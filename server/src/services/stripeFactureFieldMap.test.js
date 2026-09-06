// Montant avant taxes d'une facture Stripe : HT ET après rabais.
//
// `subtotal_excluding_tax` est hors taxes mais AVANT rabais — une facture de
// 11 600 $ remisée à 5 220 $ était enregistrée à 11 600 $ (revenu doublé,
// HT + taxes ≠ total). La source par défaut est donc `total_excluding_tax`,
// avec repli sur les anciens chemins quand Stripe ne le renvoie pas.

import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'
import assert from 'node:assert/strict'

// DB jetable — n'ouvre jamais la vraie erp.db (les lectures de config et de
// champs personnalisés sont déjà tolérantes aux tables absentes).
process.env.DATABASE_PATH = join(tmpdir(), `erp-test-stripe-facture-map-${process.pid}.db`)

const { resolveStripeInvoiceFields } = await import('./stripeFactureFieldMap.js')

test('facture remisée : le HT est celui après rabais', () => {
  const r = resolveStripeInvoiceFields({
    subtotal: 1160000,
    subtotal_excluding_tax: 1160000,
    total_excluding_tax: 522000,
    total: 600170,
  })
  assert.equal(r.amount_before_tax, 5220)
})

test('rabais de 100 % : le HT tombe à 0, pas de repli sur le sous-total', () => {
  const r = resolveStripeInvoiceFields({
    subtotal: 4000,
    subtotal_excluding_tax: 4000,
    total_excluding_tax: 0,
    total: 0,
  })
  assert.equal(r.amount_before_tax, 0)
})

test('sans total_excluding_tax : repli sur subtotal_excluding_tax puis subtotal', () => {
  assert.equal(
    resolveStripeInvoiceFields({ subtotal: 11500, subtotal_excluding_tax: 10000 }).amount_before_tax,
    100
  )
  assert.equal(
    resolveStripeInvoiceFields({ subtotal: 10000 }).amount_before_tax,
    100
  )
})
