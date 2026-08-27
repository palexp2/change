// Titre automatique d'un prompt : les fonctions pures. Les passages modèle
// (refineTitle / refineProjectTitle) ne sont PAS testés ici — ils spawneraient un
// vrai subprocess Claude.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { heuristicTitle, sanitizeModelTitle, buildThreadDigest, MAX_TITLE_LEN } from './promptTitle.js'

test('heuristicTitle garde la première phrase et capitalise', () => {
  assert.equal(heuristicTitle('corrige le bug de la page paie'), 'Corrige le bug de la page paie')
  assert.equal(
    heuristicTitle('Ajoute un bouton. Ensuite refais toute la mise en page de la section et vérifie le rendu mobile.'),
    'Ajoute un bouton',
  )
})

test('heuristicTitle ignore les lignes vides et les puces', () => {
  assert.equal(heuristicTitle('\n\n  - **Renomme** la colonne Statut\nautre chose'), 'Renomme la colonne Statut')
  assert.equal(heuristicTitle('2) vérifie les taxes'), 'Vérifie les taxes')
})

test('heuristicTitle tronque au mot entier', () => {
  const long = 'ajoute une colonne ' + 'très '.repeat(40) + 'utile'
  const t = heuristicTitle(long)
  assert.ok(t.length <= MAX_TITLE_LEN + 1, `titre trop long : ${t.length}`)
  assert.ok(t.endsWith('…'), 'points de suspension attendus')
  assert.ok(!/\s…$/.test(t), 'pas d\'espace avant les points de suspension')
})

test('heuristicTitle ne rend jamais une chaîne vide', () => {
  assert.equal(heuristicTitle(''), 'Sans titre')
  assert.equal(heuristicTitle('   \n  '), 'Sans titre')
})

test('sanitizeModelTitle nettoie guillemets, préfixe et point final', () => {
  assert.equal(sanitizeModelTitle('« Titre automatique des prompts »'), 'Titre automatique des prompts')
  assert.equal(sanitizeModelTitle('Titre : corriger la fin de mois.'), 'Corriger la fin de mois')
  assert.equal(sanitizeModelTitle('**Adapter le formulaire de paiement**'), 'Adapter le formulaire de paiement')
})

test('buildThreadDigest garde la demande puis les tours, dans l\'ordre', () => {
  const d = buildThreadDigest('Titre automatique des prompts', [
    { role: 'agent', text: 'Fait : le titre est déduit du prompt.' },
    { role: 'user', text: 'J\'aimerais que le titre soit dynamique, comme des projets.' },
  ])
  const lines = d.split('\n')
  assert.match(lines[0], /^Demande d'origine : Titre automatique des prompts$/)
  assert.match(lines[1], /^Claude : Fait/)
  assert.match(lines[2], /^Humain : J'aimerais/)
})

test('buildThreadDigest garde la FIN du fil (le cap récent) et écourte les messages', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ role: 'user', text: `message numéro ${i}` }))
  const d = buildThreadDigest('demande', many)
  assert.ok(d.includes('message numéro 29'), 'le dernier tour doit être présent')
  assert.ok(!d.includes('message numéro 0 '), 'les tours les plus anciens doivent tomber')

  const long = buildThreadDigest('demande', [{ role: 'user', text: 'a'.repeat(2000) }])
  assert.ok(long.includes('…'), 'message trop long non écourté')
  assert.ok(long.length < 1200, `digest trop gros : ${long.length}`)
})

test('sanitizeModelTitle refuse ce qui n\'est pas un titre', () => {
  assert.equal(sanitizeModelTitle(''), null)
  assert.equal(sanitizeModelTitle('ok'), null)
  assert.equal(sanitizeModelTitle('Voici le titre demandé'), null)
  assert.equal(sanitizeModelTitle('[{"title":"x"}]'), null)
  assert.equal(sanitizeModelTitle('Je ne peux pas répondre à cette demande'), null)
  assert.equal(sanitizeModelTitle('a'.repeat(200)), null)
})
