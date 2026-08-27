import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectCountry, haversineKm } from './weather.js'
import { buildAddressQuery } from './geocode.js'

test('detectCountry — l\'adresse prime sur la colonne country (défaut Canada pour tous)', () => {
  assert.equal(detectCountry({ country: 'Canada', address: '2500 Summit St, Columbus, OH 43202, USA' }), 'US')
  assert.equal(detectCountry({ country: 'Canada', address: '2325 Rue de l\'Université, Québec, QC G1V 0B3, Canada' }), 'CA')
})

test('detectCountry — replis colonne pays puis code d\'état', () => {
  assert.equal(detectCountry({ country: 'United States', address: '' }), 'US')
  assert.equal(detectCountry({ country: '', province: 'VT' }), 'US')
  assert.equal(detectCountry({ country: '', province: 'QC' }), 'CA')
  assert.equal(detectCountry({}), 'CA')
})

test('buildAddressQuery — pas de pays en double ni de pays contradictoire', () => {
  assert.equal(
    buildAddressQuery({ address: '2500 Summit St, Columbus, OH 43202, USA', country: 'Canada' }),
    '2500 Summit St, Columbus, OH 43202, USA',
  )
  assert.equal(
    buildAddressQuery({ address: '123 rue Principale', city: 'Sherbrooke', province: 'QC', country: 'Canada' }),
    '123 rue Principale, Sherbrooke, QC, Canada',
  )
})

test('buildAddressQuery — un pays seul ne situe pas un site', () => {
  assert.equal(buildAddressQuery({ country: 'Canada' }), '')
  assert.equal(buildAddressQuery(null), '')
  assert.equal(buildAddressQuery({ city: 'Québec', country: 'Canada' }), 'Québec, Canada')
})

test('haversineKm — distance Québec ↔ Montréal ≈ 233 km', () => {
  const d = haversineKm(46.8139, -71.2080, 45.5017, -73.5673)
  assert.ok(d > 225 && d < 240, `distance inattendue: ${d}`)
  assert.equal(haversineKm(46.8, -71.2, 46.8, -71.2), 0)
})
