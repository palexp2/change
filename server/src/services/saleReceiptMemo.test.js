// Mémo QB d'un reçu de vente : on NE met PAS la liste des articles. Plusieurs articles →
// description GÉNÉRALE de la facture (résumé IA de l'objet principal) ; UN SEUL article →
// sa description transcrite verbatim (pas besoin de résumer). Un mémo personnalisé saisi
// par l'utilisateur est ajouté en tête. Verrouille ce comportement + la troncature 4000.

import test from 'node:test'
import assert from 'node:assert/strict'

const { buildReceiptMemo } = await import('./quickbooks.js')

test('mémo saisi + description générale : note perso en tête, description ensuite', () => {
  assert.equal(buildReceiptMemo('Ma note perso', 'Pièces de plomberie'), 'Ma note perso\nPièces de plomberie')
})

test('mémo vide : reporte uniquement la description générale', () => {
  assert.equal(buildReceiptMemo('', 'Pièces de plomberie'), 'Pièces de plomberie')
  assert.equal(buildReceiptMemo(null, 'Pièces de plomberie'), 'Pièces de plomberie')
  assert.equal(buildReceiptMemo('   ', 'Pièces de plomberie'), 'Pièces de plomberie')
})

test('description générale absente : seul le mémo perso reste', () => {
  assert.equal(buildReceiptMemo('Ma note perso', ''), 'Ma note perso')
  assert.equal(buildReceiptMemo('Ma note perso', null), 'Ma note perso')
  assert.equal(buildReceiptMemo('Ma note perso', '   '), 'Ma note perso')
})

test('la liste des articles n’est jamais reprise dans le mémo', () => {
  // Avant : buildReceiptMemo recevait les items et les listait. Désormais le 2e arg
  // est une description générale (chaîne), pas un tableau d'articles.
  assert.equal(buildReceiptMemo(null, undefined), '')
})

test('aucun mémo, aucune description → chaîne vide', () => {
  assert.equal(buildReceiptMemo(null, ''), '')
  assert.equal(buildReceiptMemo('', undefined), '')
})

test('un seul article : transcrit sa description verbatim, pas le résumé', () => {
  // 1 article → on prend items[0].description, même si une description générale existe.
  assert.equal(
    buildReceiptMemo(null, 'Matériel électronique', [{ description: 'Câble HDMI 2 m' }]),
    'Câble HDMI 2 m',
  )
  // Mémo perso conservé en tête.
  assert.equal(
    buildReceiptMemo('Projet X', 'Résumé', [{ description: 'Câble HDMI 2 m' }]),
    'Projet X\nCâble HDMI 2 m',
  )
})

test('plusieurs articles : garde le résumé général, pas la liste', () => {
  assert.equal(
    buildReceiptMemo(null, 'Matériel électronique', [{ description: 'Câble' }, { description: 'Routeur' }]),
    'Matériel électronique',
  )
})

test('un seul article sans description : retombe sur la description générale', () => {
  assert.equal(buildReceiptMemo(null, 'Résumé général', [{ description: '   ' }]), 'Résumé général')
  assert.equal(buildReceiptMemo(null, 'Résumé général', [{}]), 'Résumé général')
})

test('troncature à 4000 caractères', () => {
  const long = 'x'.repeat(5000)
  assert.equal(buildReceiptMemo(long, '').length, 4000)
})
