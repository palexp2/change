// Préréglage automatique d'un prompt : les fonctions pures. Le passage modèle
// (classifyPreset) n'est PAS testé ici — il spawnerait un vrai subprocess Claude.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { provisionalPreset, sanitizePresetAnswer, PRESET_KEYS } from './promptPreset.js'

test('provisionalPreset : prudent en attendant le verdict', () => {
  assert.equal(provisionalPreset('implement'), 'deep')
  assert.equal(provisionalPreset('question'), 'standard')
  assert.equal(provisionalPreset(undefined), 'deep')
})

test('sanitizePresetAnswer reconnaît les trois niveaux, FR et EN', () => {
  assert.equal(sanitizePresetAnswer('RAPIDE'), 'fast')
  assert.equal(sanitizePresetAnswer('standard'), 'standard')
  assert.equal(sanitizePresetAnswer('APPROFONDI'), 'deep')
  assert.equal(sanitizePresetAnswer('approfondie'), 'deep')
  assert.equal(sanitizePresetAnswer('fast'), 'fast')
  assert.equal(sanitizePresetAnswer('deep'), 'deep')
})

test('sanitizePresetAnswer tolère guillemets, point final et lignes vides', () => {
  assert.equal(sanitizePresetAnswer('« Rapide »'), 'fast')
  assert.equal(sanitizePresetAnswer('Standard.'), 'standard')
  assert.equal(sanitizePresetAnswer('\n\n  APPROFONDI  \n'), 'deep')
})

test('sanitizePresetAnswer refuse tout ce qui n\'est pas un niveau', () => {
  assert.equal(sanitizePresetAnswer(''), null)
  assert.equal(sanitizePresetAnswer('Je recommande le niveau standard pour cette tâche'), null)
  assert.equal(sanitizePresetAnswer('{"preset":"fast"}'), null)
  assert.equal(sanitizePresetAnswer('moyen'), null)
})

test('les clés couvrent exactement les préréglages de la file', () => {
  assert.deepEqual(PRESET_KEYS, ['fast', 'standard', 'deep'])
  for (const raw of ['RAPIDE', 'STANDARD', 'APPROFONDI']) {
    assert.ok(PRESET_KEYS.includes(sanitizePresetAnswer(raw)))
  }
})
