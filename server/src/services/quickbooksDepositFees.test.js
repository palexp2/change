// Régression : un dispute BT (`type='adjustment'`/`'dispute'`) embarque le dispute
// fee Stripe (typiquement 15 USD) dans `raw.fee_details` comme `stripe_fee`. Avant
// le fix, la branche adjustment de buildDepositFromPayout n'utilisait pas
// `processing` retourné par splitFeeFromRaw — le fee finissait dans la ligne
// d'« Ajustement d'arrondi taxes » de fin de push (cas po_1Tb8r3EO122sMsbJb2oDwaJt
// → Deposit 17387, mai 2026). Le test verrouille les deux conditions du fix :
//   1) splitFeeFromRaw doit bien extraire le dispute fee dans `processing`.
//   2) bt.net = bt.amount - bt.fee — invariant Stripe sur lequel repose la
//      réconciliation du Deposit après bucket du fee.

import test from 'node:test'
import assert from 'node:assert/strict'

const { splitFeeFromRaw } = await import('./quickbooks.js')

test('Dispute BT — fee_details.stripe_fee "Dispute fee" extrait comme processing', () => {
  const bt = {
    type: 'adjustment',
    amount: -675,
    fee: 15,
    raw: JSON.stringify({
      fee_details: [
        { amount: 1500, currency: 'usd', type: 'stripe_fee', description: 'Dispute fee', application: null },
      ],
    }),
  }
  const { processing, taxGst, taxQst } = splitFeeFromRaw(bt)
  assert.equal(processing, 15, 'dispute fee doit être classé comme processing')
  assert.equal(taxGst, 0)
  assert.equal(taxQst, 0)
  // Invariant Stripe — pivot du fix de la branche adjustment.
  assert.equal(bt.amount - bt.fee, -690)
})

test('Charge BT — Sales Tax non préfixée → split 5/14.975 GST + 9.975/14.975 QST quand rate ≥ 10 %', () => {
  // BT avec processing $10 et tax $1.50 (14.975 % du HT) → mix TPS+TVQ inféré.
  const bt = {
    type: 'charge',
    amount: 100,
    fee: 11.50,
    raw: JSON.stringify({
      fee_details: [
        { amount: 1000, type: 'stripe_fee' },
        { amount: 150, type: 'tax', description: 'Sales Tax' },
      ],
    }),
  }
  const { processing, taxGst, taxQst } = splitFeeFromRaw(bt)
  assert.equal(processing, 10)
  assert.ok(Math.abs(taxGst - 1.5 * (5 / 14.975)) < 0.001)
  assert.ok(Math.abs(taxQst - 1.5 * (9.975 / 14.975)) < 0.001)
})

test('Charge BT — Canadian GST/QST explicites correctement classés', () => {
  const bt = {
    type: 'charge',
    amount: 100,
    fee: 5,
    raw: JSON.stringify({
      fee_details: [
        { amount: 320, type: 'stripe_fee' },
        { amount: 16, type: 'tax', description: 'Canadian GST' },
        { amount: 31.92, type: 'tax', description: 'Canadian QST' },
      ],
    }),
  }
  const { processing, taxGst, taxQst } = splitFeeFromRaw(bt)
  assert.equal(processing, 3.2)
  assert.equal(taxGst, 0.16)
  // 31.92 cents = 0.3192
  assert.ok(Math.abs(taxQst - 0.3192) < 0.0001)
})

test('BT sans fee_details → tous zéros (pas de crash)', () => {
  const { processing, taxGst, taxQst } = splitFeeFromRaw({ type: 'refund', amount: -100, fee: 0, raw: '{}' })
  assert.equal(processing, 0)
  assert.equal(taxGst, 0)
  assert.equal(taxQst, 0)
})
