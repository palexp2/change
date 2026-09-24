import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findScannedProducts } from '../../client/src/lib/productScan.js'

const products = [
  { id: 'p1', sku: 'ABC123', active: 0 },
  { id: 'p2', sku: 'ABC1234' },
  { id: 'deleted', sku: 'DELETED', deleted_at: '2026-09-01' },
]
const api = { serials: { list: async () => ({ data: [] }) } }

test('SKU exact, casse, pièce inactive, aucun faux positif', async () => {
  for (const code of [' abc123 ', 'ABC123']) {
    assert.deepEqual(await findScannedProducts(code, products, api), [products[0]])
  }
  for (const code of ['', 'ABC12', '0123', 'DELETED', 'UNKNOWN']) {
    assert.deepEqual(await findScannedProducts(code, products, api), [])
  }
})

test('série exacte, résultats dédoublonnés et produit absent du cache', async () => {
  let fetched = 0
  const result = await findScannedProducts('sn1', products, {
    serials: { list: async params => {
      assert.equal(params.limit, 'all')
      return { data: [{ serial: 'SN1', product_id: 'p1' }, { serial: 'SN10', product_id: 'p2' }, { serial: 'SN1', product_id: 'p1' }, { serial: 'sn1', product_id: 'new' }] }
    } },
    products: { get: async id => { fetched++; return { id, sku: 'NEW' } } },
  })
  assert.equal(fetched, 1)
  assert.deepEqual(result.map(p => p.id), ['p1', 'new'])
})

test('une erreur réseau ne se transforme pas en code inconnu', async () => {
  await assert.rejects(findScannedProducts('SN1', [], { serials: { list: async () => { throw new Error('offline') } } }), /offline/)
})
