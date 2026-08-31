import test from 'node:test'
import assert from 'node:assert/strict'

import { selectReturnRate } from './returnCarrier.js'

function rate(carrier, price) {
  return { carrier_name: carrier, total: { value: String(price), currency: 'CAD' } }
}

test('retient le transporteur préféré (CA → Purolator) quand rien n\'est plus économique au-delà du seuil', () => {
  const rates = [rate('Purolator', 20), rate('UPS', 22)]
  const { rate: chosen, reason } = selectReturnRate(rates, 'CA', { threshold: 5 })
  assert.equal(chosen.carrier_name, 'Purolator')
  assert.equal(reason, 'preferred')
})

test('bascule sur le moins cher quand l\'économie dépasse le seuil', () => {
  const rates = [rate('Canada Post', 10), rate('Purolator', 30)]
  const { rate: chosen, reason } = selectReturnRate(rates, 'CA', { threshold: 5 })
  assert.equal(chosen.carrier_name, 'Canada Post')
  assert.match(reason, /^cheaper_by_/)
})

test('ne bascule pas si l\'économie est sous le seuil', () => {
  const rates = [rate('Canada Post', 18), rate('Purolator', 20)]
  const { rate: chosen, reason } = selectReturnRate(rates, 'CA', { threshold: 5 })
  assert.equal(chosen.carrier_name, 'Purolator')
  assert.equal(reason, 'preferred')
})

test('US → UPS préféré, mais bascule si un autre tarif (déjà trié croissant) est moins cher', () => {
  const rates = [rate('FedEx', 24), rate('UPS', 25)] // pré-trié ascendant, comme getRates()
  const { rate: chosen, reason } = selectReturnRate(rates, 'US', { threshold: 0 })
  assert.equal(chosen.carrier_name, 'FedEx')
  assert.match(reason, /^cheaper_by_/)
})

test('transporteur préféré absent de la liste → fallback moins cher', () => {
  const rates = [rate('Canada Post', 15), rate('FedEx', 24)] // pré-trié ascendant
  const { rate: chosen, reason } = selectReturnRate(rates, 'CA', { threshold: 0 })
  assert.equal(chosen.carrier_name, 'Canada Post')
  assert.equal(reason, 'fallback_cheapest')
})

test('liste vide → null', () => {
  assert.equal(selectReturnRate([], 'CA'), null)
})
