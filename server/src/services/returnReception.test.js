import test from 'node:test'
import assert from 'node:assert/strict'
import { receptionInstruction, receptionShelf, matchReturnItem } from './returnReception.js'

test('les phrases sont celles d\'Airtable, au caractère près', () => {
  assert.equal(
    receptionInstruction('Retour de garantie avec échange immédiat', 'Martin'),
    "Bonjour Martin, SVP place l'article dans l'étagère d'analyse."
  )
  assert.equal(
    receptionInstruction('Retour de garantie avec échange différé', 'PA'),
    "Bonjour PA, SVP place l'article dans l'étagère d'analyse. " +
    "L'item sera analysé, réparé, nettoyé et renvoyé lors de la prochaine séance d'analyse."
  )
  assert.equal(
    receptionInstruction("Fin d'abonnement", 'Martin'),
    "Bonjour Martin, SVP place l'article dans l'étagère de reconditionnement. " +
    'PA a été avisé de la réception de cet item.'
  )
  assert.equal(
    receptionInstruction('Erreur de commande', 'Alicia'),
    "Bonjour Alicia, SVP place l'article dans l'étagère de reconditionnement."
  )
})

test('raison inconnue ou vide : reçu, mais aucune étagère inventée', () => {
  assert.equal(receptionShelf(''), null)
  assert.equal(receptionShelf('Réparation - DEPRECATED'), null)
  assert.equal(receptionInstruction('', 'Martin'), 'Bonjour Martin, article reçu. Étagère à déterminer.')
})

test('étagère par raison', () => {
  assert.equal(receptionShelf('Retour de garantie avec échange immédiat'), 'analyse')
  assert.equal(receptionShelf("Le client à changé d'idée"), 'reconditionnement')
})

test('le scan trouve la série avant le SKU, insensible à la casse', () => {
  const items = [
    { id: 'a', serial_number: 'TH5267', sku: 'TH-1' },
    { id: 'b', serial_number: null, sku: 'CV-2' },
  ]
  assert.equal(matchReturnItem(items, 'th5267').id, 'a')
  assert.equal(matchReturnItem(items, ' CV-2 ').id, 'b')
  assert.equal(matchReturnItem(items, 'inconnu'), null)
  assert.equal(matchReturnItem(items, ''), null)
})

test('deux lignes du même produit : celle qui reste à recevoir', () => {
  const items = [
    { id: 'a', sku: 'CV-2', received_at: '2026-09-01' },
    { id: 'b', sku: 'CV-2', received_at: null },
  ]
  assert.equal(matchReturnItem(items, 'CV-2').id, 'b')
})

test('nom complet d’un utilisateur Boréal : salué par le prénom', () => {
  assert.match(receptionInstruction('Retour de garantie avec échange immédiat', 'Martin Audesse'), /^Bonjour Martin, /)
})
