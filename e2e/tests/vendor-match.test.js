// Rapprochement fournisseur extrait ↔ vendors QB existants (client/src/lib/vendorMatch.js).
// Objectif : présélectionner le bon vendor existant au lieu d'en créer un doublon
// (« Amazon.com.ca ULC » doit retrouver « Amazon »), sans rattacher au mauvais
// fournisseur (« Amazon Web Services » ≠ « Amazon » détail).

const { test, describe, before } = require('node:test')
const assert = require('node:assert/strict')

const V = (...names) => names.map((DisplayName, i) => ({ Id: String(i + 1), DisplayName }))

describe('findBestVendorMatch', () => {
  let findBestVendorMatch, normalizeVendor
  before(async () => {
    // Lib en ESM, test en CommonJS → import dynamique.
    const mod = await import('../../client/src/lib/vendorMatch.js')
    findBestVendorMatch = mod.findBestVendorMatch
    normalizeVendor = mod.normalizeVendor
  })
  test('match exact à la casse/ponctuation près', () => {
    const m = findBestVendorMatch('amazon.com.ca ulc', V('Amazon.com.ca ULC', 'Bell Canada'))
    assert.equal(m?.DisplayName, 'Amazon.com.ca ULC')
  })

  test('suffixe juridique ignoré — « Amazon » retrouve « Amazon.com.ca ULC »', () => {
    const m = findBestVendorMatch('Amazon', V('Amazon.com.ca ULC', 'Bell Canada'))
    assert.equal(m?.DisplayName, 'Amazon.com.ca ULC')
  })

  test('variante de domaine — « Amazon.ca » retrouve « Amazon.com.ca ULC »', () => {
    const m = findBestVendorMatch('Amazon.ca', V('Amazon.com.ca ULC', 'Staples'))
    assert.equal(m?.DisplayName, 'Amazon.com.ca ULC')
  })

  test('anti-collision — un reçu AWS ne s’aligne PAS sur « Amazon » détail', () => {
    const m = findBestVendorMatch('Amazon Web Services Canada, Inc.', V('Amazon.com.ca ULC'))
    assert.equal(m, null)
  })

  test('AWS retrouve bien son propre vendor quand il existe', () => {
    const m = findBestVendorMatch('Amazon Web Services Canada, Inc.', V('Amazon.com.ca ULC', 'Amazon Web Services'))
    assert.equal(m?.DisplayName, 'Amazon Web Services')
  })

  test('aucun fournisseur proche — retourne null (mode « nouveau »)', () => {
    const m = findBestVendorMatch('Staples', V('Bell Canada', 'Hydro-Québec'))
    assert.equal(m, null)
  })

  test('accents et ponctuation neutralisés', () => {
    assert.equal(normalizeVendor('Hydro-Québec Inc.'), 'hydro quebec inc')
  })

  test('liste vide / nom vide — null', () => {
    assert.equal(findBestVendorMatch('Amazon', []), null)
    assert.equal(findBestVendorMatch('', V('Amazon')), null)
  })
})
