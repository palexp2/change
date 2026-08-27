// Alias de fournisseurs codés en dur (VENDOR_ALIASES) : les raisons sociales imprimées
// sur les factures doivent se canoniser vers le nom du vendor QB existant, sinon le
// rapprochement flou du client (findBestVendorMatch) échoue et l'UI propose de créer
// un doublon. Cas réel : « Federal Express Canada Corporation » ↛ « FedEx » (aucun
// token commun).

import test from 'node:test'
import assert from 'node:assert/strict'

const { canonicalVendorName } = await import('./saleReceiptExtraction.js')

test('FedEx — raison sociale complète et variantes → « FedEx »', () => {
  assert.equal(canonicalVendorName('Federal Express Canada Corporation'), 'FedEx')
  assert.equal(canonicalVendorName('FedEx'), 'FedEx')
  assert.equal(canonicalVendorName('Fedex Ground'), 'FedEx')
  assert.equal(canonicalVendorName('Fed Ex Express'), 'FedEx')
})

test('NovoXpress / Groupe Alliances et Privilèges → « Novo Express »', () => {
  assert.equal(canonicalVendorName('Groupe Alliances et Privilèges'), 'Novo Express')
  assert.equal(canonicalVendorName('NovoXpress'), 'Novo Express')
})

test('Amazon — toute variante boutique → « Amazon.ca », AWS reste distinct', () => {
  assert.equal(canonicalVendorName('Amazon'), 'Amazon.ca')
  assert.equal(canonicalVendorName('Amazon.ca'), 'Amazon.ca')
  assert.equal(canonicalVendorName('Amazon.com.ca ULC'), 'Amazon.ca')
  assert.equal(canonicalVendorName('Amazon Marketplace'), 'Amazon.ca')
  assert.equal(canonicalVendorName('Amazon Prime'), 'Amazon.ca')
  assert.equal(canonicalVendorName('Amazon Web Services'), 'Amazon Web Services')
  assert.equal(canonicalVendorName('Amazon Web Services Canada, Inc.'), 'Amazon Web Services')
  assert.equal(canonicalVendorName('AWS'), 'Amazon Web Services')
})

test('Groupe Alliances & Privilège (esperluette) → « Novo Express »', () => {
  assert.equal(canonicalVendorName('Groupe Alliances & Privilège Inc.'), 'Novo Express')
})

test('pas de faux positifs — noms sans rapport intouchés', () => {
  assert.equal(canonicalVendorName('Federated Insurance'), 'Federated Insurance')
  assert.equal(canonicalVendorName('Express Scripts'), 'Express Scripts')
  assert.equal(canonicalVendorName('Fedexpo Inc'), 'Fedexpo Inc')
  assert.equal(canonicalVendorName(null), null)
})
