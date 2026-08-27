import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fingerprintOf, parseSuggestionsJson, normalizeKind, SUGGESTION_KINDS, buildSuggestionChatPrompt } from './workSuggestions.js'

// ── Déduplication ─────────────────────────────────────────────────────────────
// L'empreinte est ce qui empêche la même idée de revenir chaque matin : elle doit
// résister à la casse, aux accents et à la ponctuation, mais distinguer deux idées.

test('empreinte insensible à la casse, aux accents et à la ponctuation', () => {
  assert.equal(
    fingerprintOf('Automatiser la conciliation bancaire'),
    fingerprintOf('automatiser  la CONCILIATION bancaire !'))
  assert.equal(
    fingerprintOf('Écritures de fin de mois'),
    fingerprintOf('Ecritures de fin de mois'))
})

test('empreinte distincte pour deux idées différentes', () => {
  assert.notEqual(
    fingerprintOf('Automatiser la conciliation bancaire'),
    fingerprintOf('Automatiser la déclaration de TPS'))
})

// ── Lecture de la réponse du modèle ───────────────────────────────────────────

test('JSON nu', () => {
  const out = parseSuggestionsJson('[{"title":"A","prompt":"p"}]')
  assert.equal(out.length, 1)
  assert.equal(out[0].title, 'A')
})

test('JSON dans un bloc de code', () => {
  const out = parseSuggestionsJson('Voici mes idées :\n```json\n[{"title":"B","prompt":"p"}]\n```\n')
  assert.equal(out.length, 1)
  assert.equal(out[0].title, 'B')
})

test('JSON entouré de texte libre', () => {
  const out = parseSuggestionsJson('Bien sûr. [{"title":"C","prompt":"p"}] Voilà.')
  assert.equal(out[0].title, 'C')
})

// ── Nature de la suggestion ───────────────────────────────────────────────────
// Une valeur inconnue ne doit jamais créer une troisième catégorie fantôme : la
// liste se filtre sur ces deux valeurs et rien d'autre.

test('nature inconnue ou absente → « chantier »', () => {
  assert.deepEqual(SUGGESTION_KINDS, ['chantier', 'integration'])
  assert.equal(normalizeKind('integration'), 'integration')
  assert.equal(normalizeKind('chantier'), 'chantier')
  assert.equal(normalizeKind('Intégration'), 'chantier')
  assert.equal(normalizeKind(undefined), 'chantier')
  assert.equal(normalizeKind(null), 'chantier')
})

test('réponse vide ou illisible → tableau vide, jamais d\'exception', () => {
  assert.deepEqual(parseSuggestionsJson(''), [])
  assert.deepEqual(parseSuggestionsJson('je ne sais pas'), [])
  assert.deepEqual(parseSuggestionsJson('[{cassé'), [])
  assert.deepEqual(parseSuggestionsJson('{"title":"objet, pas tableau"}'), [])
})

// ── Discussion d'une suggestion ───────────────────────────────────────────────
// Le prompt de discussion doit porter TOUT ce que le modèle n'ira pas chercher
// (il tourne sans outils) : la suggestion elle-même, sa nature, et le fil.

test('prompt de discussion : la suggestion et le fil y sont, et rien ne s\'exécute', () => {
  const p = buildSuggestionChatPrompt({
    suggestion: { kind: 'integration', title: 'Connecter Shippo', area: 'logistique', rationale: 'Étiquettes à la main', prompt: 'Brancher Shippo…' },
    thread: 'Humain: ça coûte combien ?',
    digest: 'Outils déjà branchés : Stripe',
  })
  assert.match(p, /Connecter Shippo/)
  assert.match(p, /logistique/)
  assert.match(p, /Étiquettes à la main/)
  assert.match(p, /Brancher Shippo/)
  assert.match(p, /Humain: ça coûte combien \?/)
  assert.match(p, /Outils déjà branchés : Stripe/)
  assert.match(p, /intégration/)
  assert.match(p, /cette discussion ne modifie rien/)
})

test('prompt de discussion : un chantier n\'est pas présenté comme une intégration', () => {
  const p = buildSuggestionChatPrompt({
    suggestion: { kind: 'chantier', title: 'Automatiser la paie', prompt: 'Faire X' },
    thread: '',
  })
  assert.match(p, /chantier/)
  assert.doesNotMatch(p, /outil externe à brancher/)
  // Fil vide : le modèle doit le voir explicitement plutôt qu'un trou.
  assert.match(p, /\(aucun échange\)/)
})
