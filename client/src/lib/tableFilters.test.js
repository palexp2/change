// Régression : `is_empty` / `is_not_empty` doivent traiter un tableau JS vide
// (`row.orders === []` quand un projet n'a aucune commande) comme vide. Avant
// le fix, le code comparait `v === '[]'` (la string), ce qui échoue toujours
// pour un Array et faisait disparaître les projets sans commandes du résultat.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyFilter, applyFilterGroup } from './tableFilters.js'

test('is_empty matche un tableau vide', () => {
  const row = { id: 'p1', status: 'Gagné', orders: [] }
  assert.equal(applyFilter(row, { field: 'orders', op: 'is_empty', value: '' }), true)
})

test('is_empty ne matche PAS un tableau non-vide', () => {
  const row = { id: 'p2', status: 'Gagné', orders: [{ id: 'o1', order_number: 1 }] }
  assert.equal(applyFilter(row, { field: 'orders', op: 'is_empty', value: '' }), false)
})

test('is_not_empty matche un tableau non-vide', () => {
  const row = { id: 'p2', status: 'Gagné', orders: [{ id: 'o1', order_number: 1 }] }
  assert.equal(applyFilter(row, { field: 'orders', op: 'is_not_empty', value: '' }), true)
})

test('is_not_empty ne matche PAS un tableau vide', () => {
  const row = { id: 'p1', status: 'Gagné', orders: [] }
  assert.equal(applyFilter(row, { field: 'orders', op: 'is_not_empty', value: '' }), false)
})

test('is_empty matche null, undefined, "" et "[]" (compat existante)', () => {
  for (const v of [null, undefined, '', '[]']) {
    assert.equal(applyFilter({ x: v }, { field: 'x', op: 'is_empty', value: '' }), true, `valeur ${JSON.stringify(v)} doit être vide`)
  }
})

test('is_empty ne matche PAS une valeur scalaire non-vide', () => {
  assert.equal(applyFilter({ x: 'foo' }, { field: 'x', op: 'is_empty', value: '' }), false)
  assert.equal(applyFilter({ x: 0 }, { field: 'x', op: 'is_empty', value: '' }), false)
})

test("scénario reporté : Statut=Gagné AND orders Est vide retourne le projet sans commandes", () => {
  const projects = [
    { id: 'p1', status: 'Gagné', orders: [{ id: 'o1' }] },
    { id: 'p2', status: 'Gagné', orders: [] },
    { id: 'p3', status: 'Ouvert', orders: [] },
  ]
  const filterGroup = {
    conjunction: 'AND',
    rules: [
      { field: 'status', op: 'equals', value: 'Gagné' },
      { field: 'orders', op: 'is_empty', value: '' },
    ],
  }
  const filtered = projects.filter(p => applyFilterGroup(p, filterGroup))
  assert.deepEqual(filtered.map(p => p.id), ['p2'])
})
