// Régression : `is_empty` / `is_not_empty` doivent traiter un tableau JS vide
// (`row.orders === []` quand un projet n'a aucune commande) comme vide. Avant
// le fix, le code comparait `v === '[]'` (la string), ce qui échoue toujours
// pour un Array et faisait disparaître les projets sans commandes du résultat.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyFilter, applyFilterGroup, countFilterRules } from './tableFilters.js'

// Les filtres de date raisonnent sur le jour affiché par la table, donc sur le
// fuseau du navigateur. Les fixtures horodatées se construisent depuis des
// composantes LOCALES pour rester valides quel que soit le fuseau du runner
// (le serveur tourne en UTC, les navigateurs à Montréal).
function localIso(y, m, d, h = 12, mi = 0, s = 0, ms = 0) {
  return new Date(y, m - 1, d, h, mi, s, ms).toISOString()
}

// 3 septembre, 10 h 23 heure locale — colonne horodatée type `interactions.timestamp`.
const TS_MORNING = localIso(2026, 9, 3, 10, 23, 41, 512)

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
  assert.equal(applyFilter({ d: localIso(2026, 3, 31, 18, 47) }, f), true)
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

test('between : date manquante sur la ligne ne matche pas', () => {
  assert.equal(applyFilter({ d: null }, { field: 'd', op: 'between', value: ['2026-01-01', '2026-03-31'] }), false)
  assert.equal(applyFilter({ d: '' }, { field: 'd', op: 'between', value: ['2026-01-01', '2026-03-31'] }), false)
})

// Une condition de date qu'on vient d'ajouter n'a pas encore de valeur : elle
// doit être inactive, pas vider la table (c'est ce qui faisait croire que le
// filtrage par date ne fonctionnait pas).
test('règle de date incomplète = règle inactive', () => {
  const row = { d: TS_MORNING }
  assert.equal(applyFilter(row, { field: 'd', op: 'before', value: '' }), true)
  assert.equal(applyFilter(row, { field: 'd', op: 'after', value: '' }), true)
  assert.equal(applyFilter(row, { field: 'd', op: 'between', value: ['', ''] }), true)
  assert.equal(applyFilter(row, { field: 'd', op: 'last_n_days', value: '' }), true)
  assert.equal(applyFilter(row, { field: 'd', op: 'next_n_days', value: '' }), true)
  assert.equal(applyFilter(row, { field: 'd', op: 'more_than_n_days_ago', value: '' }), true)
  assert.equal(applyFilter(row, { field: 'd', op: 'more_than_n_days_ahead', value: '' }), true)
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

// Régression /interactions : la colonne « Date » porte un horodatage complet
// (`timestamp` = ISO avec heure). Avant le fix, les opérateurs de date
// comparaient soit des chaînes brutes (« Le » ne matchait jamais), soit des
// instants à minuit UTC (« Avant / Après le » décalés d'un fuseau).

test('equals sur une colonne horodatée matche le jour calendaire', () => {
  assert.equal(applyFilter({ d: TS_MORNING }, { field: 'd', op: 'equals', value: '2026-09-03' }), true)
  assert.equal(applyFilter({ d: TS_MORNING }, { field: 'd', op: 'equals', value: '2026-09-04' }), false)
  assert.equal(applyFilter({ d: TS_MORNING }, { field: 'd', op: 'equals', value: '2026-09-02' }), false)
})

test('equals sur une date sans heure reste une égalité exacte', () => {
  assert.equal(applyFilter({ d: '2026-09-03' }, { field: 'd', op: 'equals', value: '2026-09-03' }), true)
  assert.equal(applyFilter({ d: '2026-09-04' }, { field: 'd', op: 'equals', value: '2026-09-03' }), false)
})

test('equals ne devient pas date-aware sur un champ texte ou numérique', () => {
  assert.equal(applyFilter({ x: 'Brouillon' }, { field: 'x', op: 'equals', value: 'brouillon' }), true)
  // Un nombre ne doit pas être interprété comme un instant epoch (1970-01-01).
  assert.equal(applyFilter({ x: 5 }, { field: 'x', op: 'equals', value: '1970-01-01' }), false)
})

test('not_equals sur une colonne horodatée exclut le jour entier', () => {
  assert.equal(applyFilter({ d: TS_MORNING }, { field: 'd', op: 'not_equals', value: '2026-09-03' }), false)
  assert.equal(applyFilter({ d: TS_MORNING }, { field: 'd', op: 'not_equals', value: '2026-09-04' }), true)
})

test('before / after excluent la journée pivot entière', () => {
  const before = { field: 'd', op: 'before', value: '2026-09-03' }
  const after = { field: 'd', op: 'after', value: '2026-09-03' }
  assert.equal(applyFilter({ d: TS_MORNING }, before), false, 'le 3 n’est pas « avant le 3 »')
  assert.equal(applyFilter({ d: TS_MORNING }, after), false, 'le 3 n’est pas « après le 3 »')
  assert.equal(applyFilter({ d: localIso(2026, 9, 2, 23, 12) }, before), true)
  assert.equal(applyFilter({ d: localIso(2026, 9, 4, 0, 30) }, after), true)
})

test('date métier Airtable (minuit UTC) : le jour du sélecteur est préservé', () => {
  // Airtable encode un champ date-only comme minuit UTC ; le convertir en heure
  // locale reculerait d'un jour à Montréal.
  const d = '2026-04-01T00:00:00.000Z'
  assert.equal(applyFilter({ d }, { field: 'd', op: 'equals', value: '2026-04-01' }), true)
  assert.equal(applyFilter({ d }, { field: 'd', op: 'before', value: '2026-04-01' }), false)
  assert.equal(applyFilter({ d }, { field: 'd', op: 'between', value: ['2026-04-01', '2026-04-30'] }), true)
  assert.equal(applyFilter({ d }, { field: 'd', op: 'between', value: ['2026-03-01', '2026-03-31'] }), false)
})

test('between : la borne basse inclut toute la journée (datetime)', () => {
  const f = { field: 'd', op: 'between', value: ['2026-09-03', '2026-09-10'] }
  assert.equal(applyFilter({ d: TS_MORNING }, f), true)
  assert.equal(applyFilter({ d: localIso(2026, 9, 10, 21, 0) }, f), true)
})

test('opérateurs relatifs : today / yesterday / this_month sur un horodatage', () => {
  const now = new Date()
  const iso = d => d.toISOString()
  const yest = new Date(now.getTime() - 86400000)
  assert.equal(applyFilter({ d: iso(now) }, { field: 'd', op: 'today', value: '' }), true)
  assert.equal(applyFilter({ d: iso(yest) }, { field: 'd', op: 'today', value: '' }), false)
  assert.equal(applyFilter({ d: iso(now) }, { field: 'd', op: 'this_month', value: '' }), true)
  assert.equal(applyFilter({ d: localIso(1999, 1, 4) }, { field: 'd', op: 'this_month', value: '' }), false)
  assert.equal(applyFilter({ d: null }, { field: 'd', op: 'today', value: '' }), false)
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
