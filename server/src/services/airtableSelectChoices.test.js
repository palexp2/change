import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeChoices, mergeNativeChoices } from './airtableSelectChoices.js'

const parse = r => JSON.parse(r.json)

test('ajoute les choix Airtable manquants sans toucher aux existants', () => {
  const before = JSON.stringify({
    choices: [{ id: 'opt_a', label: 'Urgent', color: 'orange' }],
    default_id: 'opt_a', default_ids: [], alphabetize: false,
  })
  const res = mergeChoices(before, ['Urgent', 'Ultra urgent'])
  assert.equal(res.added, 1)
  const after = parse(res)
  assert.deepEqual(after.choices[0], { id: 'opt_a', label: 'Urgent', color: 'orange' })
  assert.equal(after.choices[1].label, 'Ultra urgent')
  assert.equal(after.default_id, 'opt_a')
})

test('rien de neuf → aucune écriture', () => {
  const before = JSON.stringify({ choices: [{ id: 'opt_a', label: 'Urgent', color: 'orange' }] })
  assert.equal(mergeChoices(before, ['Urgent']), null)
  assert.equal(mergeChoices(before, []), null)
})

test('champ sans config : la liste Airtable devient la liste des choix', () => {
  const res = mergeChoices(null, ['A', 'B'])
  assert.equal(res.added, 2)
  assert.deepEqual(parse(res).choices.map(c => c.label), ['A', 'B'])
})

test('un choix retiré à la main ne revient pas déguisé : comparaison sur le libellé exact', () => {
  const before = JSON.stringify({ choices: [{ id: 'opt_a', label: 'Urgent', color: 'red' }] })
  const res = mergeChoices(before, [' Urgent ', 'urgent'])
  // « Urgent » (espaces en trop) est le même choix ; « urgent » est un autre
  // libellé côté Airtable, donc un vrai choix de plus.
  assert.equal(res.added, 1)
  assert.deepEqual(parse(res).choices.map(c => c.label), ['Urgent', 'urgent'])
})

test('alphabétisation respectée quand le champ la demande', () => {
  const before = JSON.stringify({ choices: [{ id: 'opt_b', label: 'B', color: 'gray' }], alphabetize: true })
  const res = mergeChoices(before, ['A'])
  assert.deepEqual(parse(res).choices.map(c => c.label), ['A', 'B'])
})

test('champ natif : complété seulement s\'il a déjà une config de choix', () => {
  assert.equal(mergeNativeChoices(null, ['A']), null)
  assert.equal(mergeNativeChoices(JSON.stringify({ choices: [] }), ['A']), null)
  const before = JSON.stringify({ choices: [{ value: 'Urgent', label: 'Prioritaire', color: 'red' }] })
  const res = mergeNativeChoices(before, ['Urgent', 'Ultra urgent'])
  assert.equal(res.added, 1)
  const after = JSON.parse(res.json)
  // Le renommage d'affichage posé par l'utilisateur survit.
  assert.deepEqual(after.choices[0], { value: 'Urgent', label: 'Prioritaire', color: 'red' })
  assert.deepEqual(after.choices[1], { value: 'Ultra urgent', label: 'Ultra urgent', color: null })
})
