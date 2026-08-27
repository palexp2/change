// Mémo QB d'un reçu de vente : on NE met PAS la liste des articles. La description
// GÉNÉRALE de la facture (« Description principale », éditable par l'utilisateur) est
// toujours prioritaire. On ne retombe sur la description de l'unique article que si
// cette description générale est vide. Un mémo personnalisé saisi par l'utilisateur est
// ajouté en tête. Verrouille ce comportement + la troncature 4000.

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

test('un seul article : la description générale reste prioritaire', () => {
  // Description générale renseignée → toujours utilisée, même avec 1 seul article.
  assert.equal(
    buildReceiptMemo(null, 'Matériel électronique', [{ description: 'Câble HDMI 2 m' }]),
    'Matériel électronique',
  )
  assert.equal(
    buildReceiptMemo('Projet X', 'Résumé', [{ description: 'Câble HDMI 2 m' }]),
    'Projet X\nRésumé',
  )
  // Description générale vide → retombe sur la description de l'unique article, verbatim.
  assert.equal(
    buildReceiptMemo(null, '', [{ description: 'Câble HDMI 2 m' }]),
    'Câble HDMI 2 m',
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

// ── Période de service (abonnements, télécom, licences…) ─────────────────────
// Reportée en queue de mémo pour qu'en fin d'année on sache quelle facture couvre
// quel mois. Jamais dupliquée si la description la mentionne déjà.

test('période reportée en queue de mémo', () => {
  assert.equal(
    buildReceiptMemo(null, 'Abonnement Slack', [], 'juillet 2026'),
    'Abonnement Slack\nPériode : juillet 2026',
  )
  assert.equal(
    buildReceiptMemo('Projet X', 'Abonnement Slack', [], 'juillet 2026'),
    'Projet X\nAbonnement Slack\nPériode : juillet 2026',
  )
})

test('période déjà présente dans la description : pas de doublon', () => {
  assert.equal(
    buildReceiptMemo(null, 'Abonnement Slack — juillet 2026', [], 'juillet 2026'),
    'Abonnement Slack — juillet 2026',
  )
  // Comparaison insensible à la casse et aux accents.
  assert.equal(
    buildReceiptMemo(null, 'Forfait cellulaire Aout 2026', [], 'août 2026'),
    'Forfait cellulaire Aout 2026',
  )
})

test('sans période : mémo inchangé (achat ponctuel)', () => {
  assert.equal(buildReceiptMemo(null, 'Pièces de plomberie', [], null), 'Pièces de plomberie')
  assert.equal(buildReceiptMemo(null, 'Pièces de plomberie', [], '  '), 'Pièces de plomberie')
})

test('période seule, sans mémo ni description', () => {
  assert.equal(buildReceiptMemo(null, '', [], 'juillet 2026'), 'Période : juillet 2026')
})
