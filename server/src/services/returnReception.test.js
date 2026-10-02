import test from 'node:test'
import assert from 'node:assert/strict'
import { receptionInstruction, receptionShelf, matchReturnItem } from './returnReception.js'

test('phrases affichées au réceptionniste', () => {
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
    "Bonjour Alicia, SVP place l'article dans l'étagère d'analyse."
  )
})

test('raison vide ou inconnue : étagère d\'analyse', () => {
  assert.equal(receptionShelf(''), 'analyse')
  assert.equal(receptionShelf('Réparation - DEPRECATED'), 'analyse')
  assert.equal(receptionInstruction('', 'Martin'), "Bonjour Martin, SVP place l'article dans l'étagère d'analyse.")
})

test('étagère par raison : seule la fin d\'abonnement va au reconditionnement', () => {
  assert.equal(receptionShelf("Fin d'abonnement"), 'reconditionnement')
  assert.equal(receptionShelf('Retour de garantie avec échange immédiat'), 'analyse')
  assert.equal(receptionShelf("Le client à changé d'idée"), 'analyse')
  assert.equal(receptionShelf('Erreur de commande'), 'analyse')
  assert.equal(receptionShelf("Retour d'équipement de courtoisie"), 'analyse')
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
