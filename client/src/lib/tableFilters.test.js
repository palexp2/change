// Régression : `is_empty` / `is_not_empty` doivent traiter un tableau JS vide
// (`row.orders === []` quand un projet n'a aucune commande) comme vide. Avant
// le fix, le code comparait `v === '[]'` (la string), ce qui échoue toujours
// pour un Array et faisait disparaître les projets sans commandes du résultat.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyFilter, applyFilterGroup, countFilterRules } from './tableFilters.js'

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

test('between : matche une date dans la plage (bornes incluses)', () => {
  const f = { field: 'd', op: 'between', value: ['2026-01-01', '2026-03-31'] }
  assert.equal(applyFilter({ d: '2026-02-15' }, f), true)
  assert.equal(applyFilter({ d: '2026-01-01' }, f), true, 'borne basse incluse')
  assert.equal(applyFilter({ d: '2026-03-31' }, f), true, 'borne haute incluse')
})

test('between : la borne haute inclut toute la journée (datetime)', () => {
  const f = { field: 'd', op: 'between', value: ['2026-01-01', '2026-03-31'] }
  assert.equal(applyFilter({ d: '2026-03-31T18:47:10.533Z' }, f), true)
  assert.equal(applyFilter({ d: '2026-04-01T00:00:00.000Z' }, f), false)
})

test('between : exclut hors plage', () => {
  const f = { field: 'd', op: 'between', value: ['2026-01-01', '2026-03-31'] }
  assert.equal(applyFilter({ d: '2025-12-31' }, f), false)
  assert.equal(applyFilter({ d: '2026-04-01' }, f), false)
})

test('between : borne unique se comporte comme ≥ ou ≤', () => {
  assert.equal(applyFilter({ d: '2026-05-01' }, { field: 'd', op: 'between', value: ['2026-01-01', ''] }), true)
  assert.equal(applyFilter({ d: '2025-12-01' }, { field: 'd', op: 'between', value: ['2026-01-01', ''] }), false)
  assert.equal(applyFilter({ d: '2026-02-01' }, { field: 'd', op: 'between', value: ['', '2026-03-31'] }), true)
  assert.equal(applyFilter({ d: '2026-05-01' }, { field: 'd', op: 'between', value: ['', '2026-03-31'] }), false)
})

test('between : value vide ou date manquante ne matche pas', () => {
  assert.equal(applyFilter({ d: '2026-02-01' }, { field: 'd', op: 'between', value: ['', ''] }), false)
  assert.equal(applyFilter({ d: null }, { field: 'd', op: 'between', value: ['2026-01-01', '2026-03-31'] }), false)
  assert.equal(applyFilter({ d: '' }, { field: 'd', op: 'between', value: ['2026-01-01', '2026-03-31'] }), false)
})

test('between : fonctionne dans un groupe OR (trimestre vs autre règle)', () => {
  const rows = [
    { id: 'a', document_date: '2026-02-10', status: 'Brouillon' },
    { id: 'b', document_date: '2026-08-10', status: 'Envoyée' },
    { id: 'c', document_date: '2026-08-10', status: 'Brouillon' },
  ]
  const group = {
    conjunction: 'OR',
    rules: [
      { field: 'document_date', op: 'between', value: ['2026-01-01', '2026-03-31'] },
      { field: 'status', op: 'equals', value: 'Envoyée' },
    ],
  }
  assert.deepEqual(rows.filter(r => applyFilterGroup(r, group)).map(r => r.id), ['a', 'b'])
})

test('groupes imbriqués : (A=X ET B=Y) OU (C=Z)', () => {
  const rows = [
    { id: 'a', type: 'X', tag: 'Y', state: 'W' },   // matche le 1er groupe
    { id: 'b', type: 'X', tag: 'N', state: 'W' },   // A=X mais B≠Y, et C≠Z → exclu
    { id: 'c', type: 'M', tag: 'N', state: 'Z' },   // matche le 2e groupe
    { id: 'd', type: 'M', tag: 'N', state: 'W' },   // aucun → exclu
  ]
  const group = {
    conjunction: 'OR',
    rules: [
      {
        conjunction: 'AND',
        rules: [
          { field: 'type', op: 'equals', value: 'X' },
          { field: 'tag', op: 'equals', value: 'Y' },
        ],
      },
      {
        conjunction: 'AND',
        rules: [{ field: 'state', op: 'equals', value: 'Z' }],
      },
    ],
  }
  assert.deepEqual(rows.filter(r => applyFilterGroup(r, group)).map(r => r.id), ['a', 'c'])
})

test('groupes imbriqués sur 3 niveaux', () => {
  const group = {
    conjunction: 'AND',
    rules: [
      { field: 'a', op: 'equals', value: '1' },
      {
        conjunction: 'OR',
        rules: [
          { field: 'b', op: 'equals', value: '2' },
          {
            conjunction: 'AND',
            rules: [
              { field: 'c', op: 'equals', value: '3' },
              { field: 'd', op: 'equals', value: '4' },
            ],
          },
        ],
      },
    ],
  }
  // a=1 ET (b=2 OU (c=3 ET d=4))
  assert.equal(applyFilterGroup({ a: '1', b: '2' }, group), true)
  assert.equal(applyFilterGroup({ a: '1', c: '3', d: '4' }, group), true)
  assert.equal(applyFilterGroup({ a: '1', c: '3', d: 'X' }, group), false)
  assert.equal(applyFilterGroup({ a: 'X', b: '2' }, group), false)
})

test('countFilterRules compte les feuilles, pas les groupes', () => {
  assert.equal(countFilterRules([]), 0)
  assert.equal(countFilterRules([{ field: 'a' }, { field: 'b' }]), 2)
  assert.equal(countFilterRules({ conjunction: 'AND', rules: [] }), 0)
  const nested = {
    conjunction: 'OR',
    rules: [
      { field: 'a' },
      { conjunction: 'AND', rules: [{ field: 'b' }, { field: 'c' }] },
    ],
  }
  assert.equal(countFilterRules(nested), 3)
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
