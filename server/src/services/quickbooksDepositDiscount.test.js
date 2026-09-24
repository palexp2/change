// Régression : sur une facture Stripe à rabais, invoice.subtotal est AVANT rabais
// et peut dépasser invoice.total — le ratio HT/TTC dérapait au-delà de 1 et gonflait
// le Deposit QB (cas Artisans Maraichers JQGA5BF3-0002, sept. 2026 : Deposit 17936
// posté à 11000 $ HT / 12647,25 $ TTC au lieu de 7700 $ HT / 8853,10 $ TTC — un
// dépôt en double). Le fix : soustraire total_discount_amounts avant le ratio.

import test from 'node:test'
import assert from 'node:assert/strict'
import '../test-helpers/testEnv.js'

const { deriveHtFromTtc } = await import('./quickbooks.js')

test('facture avec rabais Stripe (subtotal > total) — HT net du rabais, pas gonflé', () => {
  const invoice = {
    subtotal: 1100000, // 11000.00 $ avant rabais
    total: 885310,      // 8853.10 $ après 30 % de rabais + taxes
    total_discount_amounts: [{ amount: 330000 }], // 3300.00 $ de rabais
  }
  const ht = deriveHtFromTtc(8853.10, invoice, null)
  assert.equal(ht, 7700, 'HT doit être net du rabais (7700), pas le subtotal brut (11000)')
})

test('facture sans rabais — ratio subtotal/total inchangé', () => {
  const invoice = { subtotal: 1000000, total: 1114975, total_discount_amounts: [] }
  const ht = deriveHtFromTtc(11149.75, invoice, null)
  assert.equal(ht, 10000)
})

test('pas d\'invoice Stripe — repli sur les totaux de la facture ERP', () => {
  const facture = { amount_before_tax_cad: 7700, total_amount: 8853.10 }
  const ht = deriveHtFromTtc(8853.10, null, facture)
  assert.equal(ht, 7700)
})

test('ni invoice ni facture exploitable — le TTC reçu passe tel quel', () => {
  const ht = deriveHtFromTtc(500, null, null)
  assert.equal(ht, 500)
})

test('Black Creek : dépôt complet et partiel après rabais de 10 %', () => {
  const invoice = { subtotal: 2320000, total: 2359440, total_excluding_tax: 2088000, total_discount_amounts: [{ amount: 232000 }] }
  assert.equal(deriveHtFromTtc(23594.40, invoice, null), 20880)
  assert.equal(deriveHtFromTtc(11797.20, invoice, null), 10440)
})

test('prix taxes incluses : le montant déposé exclut les taxes après rabais', () => {
  const invoice = { subtotal: 11300, total: 10170, total_discount_amounts: [{ amount: 1130 }], total_taxes: [{ amount: 1170 }] }
  assert.equal(deriveHtFromTtc(101.70, invoice, null), 90)
})
