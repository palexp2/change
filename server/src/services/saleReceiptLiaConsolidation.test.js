// Consolidation « article LIA unique » : quand un reçu n'a qu'UN seul article dont la
// description commence par un code LIA (« LIA-1968 … »), les autres lignes (transport,
// frais de carte…) sont fusionnées dans cette ligne LIA — un seul item au montant total,
// description LIA conservée. Plusieurs articles LIA → on ne touche à rien.

import test from 'node:test'
import assert from 'node:assert/strict'

const { consolidateSoleLiaItem } = await import('./saleReceiptExtraction.js')

test('un seul article LIA + frais — fusion en une ligne au montant total', () => {
  const items = [
    { description: 'LIA-1968\tTD191-B 4G LTE dongle', total: 435 },
    { description: 'JACS FedEx Ground to Canada', total: 75 },
    { description: 'Credit Card Processing Fee', total: 16.58 },
  ]
  const out = consolidateSoleLiaItem(items)
  assert.equal(out.length, 1)
  assert.equal(out[0].description, 'LIA-1968\tTD191-B 4G LTE dongle')
  assert.equal(out[0].total, 526.58)
})

test('plusieurs articles LIA — intouché', () => {
  const items = [
    { description: 'LIA-1966 - LVM60 Automatisation', total: 200 },
    { description: 'LIA-1967 - LVM60 Automatisation', total: 200 },
    { description: 'Frais de transport', total: 50 },
  ]
  const out = consolidateSoleLiaItem(items)
  assert.equal(out.length, 3)
  assert.deepEqual(out, items)
})

test('aucun article LIA — intouché', () => {
  const items = [
    { description: 'Abonnement mensuel', total: 30 },
    { description: 'Frais de service', total: 5 },
  ]
  const out = consolidateSoleLiaItem(items)
  assert.equal(out.length, 2)
  assert.deepEqual(out, items)
})

test('un seul article LIA sans frais — intouché (rien à fusionner)', () => {
  const items = [{ description: 'LIA-1970\tRondelles', total: 12 }]
  const out = consolidateSoleLiaItem(items)
  assert.equal(out.length, 1)
  assert.deepEqual(out, items)
})

test('fusion via unit_price × quantity quand total absent', () => {
  const items = [
    { description: 'LIA-1978\tCable USB', unit_price: 10, quantity: 2 },
    { description: 'Shipping', total: 5 },
  ]
  const out = consolidateSoleLiaItem(items)
  assert.equal(out.length, 1)
  assert.equal(out[0].total, 25)
})

test('liste vide ou non-tableau — robuste', () => {
  assert.deepEqual(consolidateSoleLiaItem([]), [])
  assert.deepEqual(consolidateSoleLiaItem(null), [])
  assert.deepEqual(consolidateSoleLiaItem(undefined), [])
})

test('mot commençant par « Lia » sans numéro — pas considéré LIA', () => {
  const items = [
    { description: 'Liaison réseau', total: 100 },
    { description: 'Frais', total: 10 },
  ]
  const out = consolidateSoleLiaItem(items)
  assert.equal(out.length, 2, 'aucun code LIA réel → intouché')
})
