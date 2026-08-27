import { test } from 'node:test'
import assert from 'node:assert'
import { senderAllowed } from './gmail.js'

// Liste blanche d'expéditeurs de l'autodétection (boîtes personnelles :
// seule une facture d'un fournisseur listé doit remonter dans les reçus).
test('liste vide = aucune restriction', () => {
  assert.equal(senderAllowed('Quelquun <ami@gmail.com>', []), true)
})

test('domaine autorisé, avec et sans nom affiché', () => {
  assert.equal(senderAllowed('Anthropic <invoice+statements@anthropic.com>', ['anthropic.com']), true)
  assert.equal(senderAllowed('receipts@anthropic.com', ['anthropic.com']), true)
})

test('sous-domaine du domaine autorisé', () => {
  assert.equal(senderAllowed('Anthropic <no-reply@mail.anthropic.com>', ['anthropic.com']), true)
})

test('expéditeur hors liste rejeté', () => {
  assert.equal(senderAllowed('Amazon <auto-confirm@amazon.ca>', ['anthropic.com']), false)
  assert.equal(senderAllowed('Maman <maman@gmail.com>', ['anthropic.com']), false)
})

test('domaine voisin trompeur rejeté', () => {
  // « notanthropic.com » ne doit pas passer via un endsWith naïf.
  assert.equal(senderAllowed('x@notanthropic.com', ['anthropic.com']), false)
})

test('adresse complète autorisée seule', () => {
  assert.equal(senderAllowed('billing@anthropic.com', ['billing@anthropic.com']), true)
  assert.equal(senderAllowed('marketing@anthropic.com', ['billing@anthropic.com']), false)
})

test('en-tête From vide rejeté quand une restriction existe', () => {
  assert.equal(senderAllowed('', ['anthropic.com']), false)
})
