import '../test-helpers/initSchemaPreload.js'
import test from 'node:test'
import assert from 'node:assert/strict'

import db from '../db/database.js'
import { classifyChange, gateContractChange, recordEvent } from './subscriptionEvents.js'
import { contractSignature, getContractSignature, setContractSignature } from './subscriptionItemsSnapshot.js'

const item = (price, cents, qty = 1, interval = 'month') => ({
  id: `si_${price}`,
  quantity: qty,
  price: { id: price, unit_amount: cents, currency: 'cad', recurring: { interval, interval_count: 1 }, product: { id: 'prod_x', name: 'Nom changeant' } },
})
const sub = (over = {}) => ({ status: 'active', items: { data: [item('price_a', 3000)] }, discounts: [], ...over })

// Décision complète d'un chemin webhook/sync : classifyChange puis la garde.
const decide = (prevSub, nextSub, prevAmount, newAmount) => gateContractChange({
  category: classifyChange({ prevStatus: 'active', newStatus: 'active', prevAmount, newAmount }),
  storedSignature: contractSignature(prevSub),
  signature: contractSignature(nextSub),
})

test('même contrat, montant passé de taxes incluses à hors taxes → aucun mouvement', () => {
  const s = sub()
  const renamed = sub({ items: { data: [{ ...item('price_a', 3000), metadata: { erp_contact_id: 'c1' } }] } })
  renamed.items.data[0].price.product.name = 'Autre nom'
  assert.deepEqual(decide(s, renamed, 34.49, 30), { category: null, storeSignature: false })
})

test('quantité changée → upgrade', () => {
  const r = decide(sub(), sub({ items: { data: [item('price_a', 3000, 2)] } }), 30, 60)
  assert.equal(r.category, 'upgrade')
  assert.equal(r.storeSignature, true)
})

test('coupon retiré (fin de gratuité) → upgrade', () => {
  const r = decide(sub({ discounts: ['di_free'] }), sub({ discounts: [] }), 0, 30)
  assert.equal(r.category, 'upgrade')
})

test('rabais expandé (webhook) ou id seul (sync) : même signature', () => {
  const a = contractSignature(sub({ discounts: [{ id: 'di_1', source: { coupon: { id: 'C', percent_off: 100 } } }] }))
  const b = contractSignature(sub({ discounts: ['di_1'] }))
  assert.deepEqual(a, b)
})

test('fin d\'essai (trialing → active) → upgrade', () => {
  const r = gateContractChange({
    category: classifyChange({ prevStatus: 'trialing', newStatus: 'active', prevAmount: 0, newAmount: 30 }),
    storedSignature: contractSignature(sub({ status: 'trialing' })),
    signature: contractSignature(sub()),
  })
  assert.equal(r.category, 'upgrade')
})

test('aucune signature mémorisée → on initialise sans mouvement', () => {
  const r = gateContractChange({ category: 'downgrade', storedSignature: null, signature: contractSignature(sub()) })
  assert.deepEqual(r, { category: null, storeSignature: true })
})

test('contrat changé avant la facture : référence gardée pour que la facture compte', () => {
  const before = sub()
  const after = sub({ items: { data: [item('price_a', 3000, 2)] } })
  const first = decide(before, after, 30, 30)
  assert.deepEqual(first, { category: null, storeSignature: false })
  // Facture suivante : l'ancienne référence est toujours là → upgrade.
  assert.equal(decide(before, after, 30, 60).category, 'upgrade')
})

test('signature persistée dans le miroir des items', () => {
  db.prepare("INSERT INTO subscriptions (id, status, amount_monthly) VALUES ('sub_sig', 'active', 30)").run()
  const sig = contractSignature(sub())
  setContractSignature('sub_sig', sig, [])
  assert.deepEqual(getContractSignature('sub_sig'), sig)
})

test('churn après une baisse du même jour : retire le MRR suivi, daté après la baisse', async () => {
  db.prepare("INSERT INTO subscriptions (id, status, amount_monthly) VALUES ('sub_churn', 'active', 5)").run()
  await recordEvent({ subscriptionId: 'sub_churn', eventDate: '2026-05-05T00:00:00.000Z', eventType: 'creation', category: 'creation', newAmount: 5 })
  await recordEvent({ subscriptionId: 'sub_churn', eventDate: '2026-08-11T14:43:00.000Z', eventType: 'downgrade', category: 'downgrade', previousAmount: 5, newAmount: 4.25 })
  // Montant courant déjà recalculé (3) et date à minuit : les deux sont faux.
  const r = await recordEvent({ subscriptionId: 'sub_churn', eventDate: '2026-08-11T00:00:00.000Z', eventType: 'churn', category: 'churn', previousAmount: 3 })
  const churn = db.prepare('SELECT * FROM subscription_events WHERE id = ?').get(r.id)
  assert.equal(churn.previous_amount_cad, 4.25)
  assert.equal(churn.amount_cad_delta, -4.25)
  assert.ok(Date.parse(churn.event_date) > Date.parse('2026-08-11T14:43:00.000Z'))
  const sum = db.prepare("SELECT SUM(amount_cad_delta) FROM subscription_events WHERE subscription_id = 'sub_churn'").pluck().get()
  assert.ok(Math.abs(sum) < 0.005)
})
