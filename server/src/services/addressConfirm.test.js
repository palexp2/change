import test from 'node:test'
import assert from 'node:assert/strict'
import { sameStreet, buildQuery, addressSignature, confirmAddressInput } from './addressConfirm.js'

const ADDR = { line1: '2600 boul. Laurier', city: 'Québec', province: 'QC', postal_code: 'G1V 4T3', country: 'CA', address_type: 'Livraison' }

test('sameStreet tolère abréviations, accents et compléments d\'adresse', () => {
  assert.ok(sameStreet('2600 boul. Laurier', '2600 Boulevard Laurier'))
  assert.ok(sameStreet('2600 Boulevard Laurier, app. 4', '2600 Boul Laurier'))
  assert.ok(sameStreet('12 rue de l\'Église', '12 Rue Eglise'))
  // Google n'a pas rendu de rue : rien à opposer à la saisie.
  assert.ok(sameStreet('2600 boul. Laurier', ''))
})

test('sameStreet refuse un autre numéro civique ou une autre rue', () => {
  assert.equal(sameStreet('2601 boul. Laurier', '2600 Boulevard Laurier'), false)
  assert.equal(sameStreet('2600 rue Saint-Jean', '2600 Boulevard Laurier'), false)
})

test('buildQuery exige rue + ville et nomme le pays', () => {
  assert.equal(buildQuery(ADDR), '2600 boul. Laurier, Québec, QC, G1V 4T3, Canada')
  assert.equal(buildQuery({ ...ADDR, line1: '' }), '')
  assert.equal(buildQuery({ ...ADDR, city: '  ' }), '')
  assert.match(buildQuery({ ...ADDR, country: 'US', province: 'VT' }), /USA$/)
})

test('addressSignature ignore casse et accents, mais suit le type', () => {
  assert.equal(addressSignature(ADDR), addressSignature({ ...ADDR, city: 'QUEBEC' }))
  assert.notEqual(addressSignature(ADDR), addressSignature({ ...ADDR, address_type: 'Ferme' }))
})

// Réponses Google simulées : findplacefromtext puis details.
function stubPlaces(components, { candidates = true } = {}) {
  const real = global.fetch
  global.fetch = async (url) => ({
    ok: true,
    json: async () => (String(url).includes('findplacefromtext')
      ? (candidates
        ? { status: 'OK', candidates: [{ place_id: 'p1', formatted_address: 'F', geometry: { location: { lat: 1, lng: 2 } } }] }
        : { status: 'ZERO_RESULTS', candidates: [] })
      : { status: 'OK', result: { formatted_address: 'F', address_components: components } }),
  })
  return () => { global.fetch = real }
}

const comp = (long, short, ...types) => ({ long_name: long, short_name: short, types })
const QUEBEC = [
  comp('2600', '2600', 'street_number'), comp('Boulevard Laurier', 'Boul Laurier', 'route'),
  comp('Québec', 'Québec', 'locality'), comp('Québec', 'QC', 'administrative_area_level_1'),
  comp('G1V 4T3', 'G1V 4T3', 'postal_code'), comp('Canada', 'CA', 'country'),
]

test('adresse identique à celle de Google → confirmée', async () => {
  process.env.GOOGLE_MAPS_API_KEY = 'test-key'
  const restore = stubPlaces(QUEBEC)
  try {
    const out = await confirmAddressInput(ADDR)
    assert.equal(out.status, 'confirmed')
    assert.equal(out.suggestion, null)
  } finally { restore() }
})

test('code postal divergent → correction proposée', async () => {
  process.env.GOOGLE_MAPS_API_KEY = 'test-key'
  const restore = stubPlaces(QUEBEC)
  try {
    const out = await confirmAddressInput({ ...ADDR, postal_code: 'G1V 0B3' })
    assert.equal(out.status, 'corrected')
    assert.deepEqual(out.diff, ['postal_code'])
    assert.equal(out.suggestion.postal_code, 'G1V 4T3')
  } finally { restore() }
})

test('adresse inconnue de Google → introuvable', async () => {
  process.env.GOOGLE_MAPS_API_KEY = 'test-key'
  const restore = stubPlaces(QUEBEC, { candidates: false })
  try {
    assert.equal((await confirmAddressInput(ADDR)).status, 'not_found')
  } finally { restore() }
})

test('rue ou ville absente → incomplète, aucun appel réseau', async () => {
  const out = await confirmAddressInput({ ...ADDR, city: '' })
  assert.equal(out.status, 'incomplete')
})

test('rue ET ville divergentes → introuvable, pas de « Utiliser » trompeur', async () => {
  process.env.GOOGLE_MAPS_API_KEY = 'test-key'
  const restore = stubPlaces(QUEBEC)
  try {
    const out = await confirmAddressInput({ ...ADDR, line1: '99999 rue Qwertyuiop', city: 'Saint-Zzz' })
    assert.equal(out.status, 'not_found')
    assert.equal(out.suggestion, null)
  } finally { restore() }
})

test('« Canada » face au « CA » de Google n\'est pas une divergence', async () => {
  process.env.GOOGLE_MAPS_API_KEY = 'test-key'
  const restore = stubPlaces(QUEBEC)
  try {
    const out = await confirmAddressInput({ ...ADDR, country: 'Canada' })
    assert.equal(out.status, 'confirmed')
  } finally { restore() }
})
