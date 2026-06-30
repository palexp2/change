// Unit tests for the field-rule predicate builder.
// buildOpPredicate is the single source of truth shared by the live candidate
// query and the dry-run preview — a divergence here would make "Tester" lie
// about what the rule fires on. Pure function, no DB needed.

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildOpPredicate, buildConditionsPredicate, buildTriggerPredicate, triggerColumns } from './fieldRuleEngine.js'

test('eq / ne produce direct comparisons with the raw value', () => {
  assert.deepEqual(buildOpPredicate('status', 'eq', 'Payée'), {
    predicate: 't.status = ?',
    params: ['Payée'],
  })
  assert.deepEqual(buildOpPredicate('status', 'ne', 'Payée'), {
    predicate: 't.status != ?',
    params: ['Payée'],
  })
})

test('not_null ignores value and checks IS NOT NULL + non-empty', () => {
  const { predicate, params } = buildOpPredicate('tracking', 'not_null', undefined)
  assert.match(predicate, /t\.tracking IS NOT NULL/)
  assert.match(predicate, /t\.tracking != ''/)
  assert.deepEqual(params, [])
})

test('in expands to a parameterized IN list', () => {
  assert.deepEqual(buildOpPredicate('status', 'in', ['A', 'B', 'C']), {
    predicate: 't.status IN (?,?,?)',
    params: ['A', 'B', 'C'],
  })
})

test('empty in list is an always-false predicate', () => {
  assert.deepEqual(buildOpPredicate('status', 'in', []), {
    predicate: '1=0',
    params: [],
  })
})

test('numeric ops CAST the column to REAL and coerce value to Number', () => {
  // The column is TEXT in DB (e.g. orders.nombre_d_items) — without CAST,
  // "10" < "2" lexicographically. The CAST is what makes "> 1" mean numeric.
  assert.deepEqual(buildOpPredicate('nombre_d_items', 'gt', '1'), {
    predicate: 'CAST(t.nombre_d_items AS REAL) > ?',
    params: [1],
  })
  assert.deepEqual(buildOpPredicate('qty', 'gte', 2), {
    predicate: 'CAST(t.qty AS REAL) >= ?',
    params: [2],
  })
  assert.deepEqual(buildOpPredicate('qty', 'lt', '5').predicate, 'CAST(t.qty AS REAL) < ?')
  assert.deepEqual(buildOpPredicate('qty', 'lte', 5).predicate, 'CAST(t.qty AS REAL) <= ?')
})

test('multi-condition AND joins each parenthesized condition with AND', () => {
  const { predicate, params } = buildConditionsPredicate({
    conjunction: 'AND',
    rules: [
      { column: 'status', op: 'eq', value: 'Ouvert' },
      { column: 'urgence', op: 'gt', value: '5' },
    ],
  })
  assert.equal(predicate, '((t.status = ?) AND (CAST(t.urgence AS REAL) > ?))')
  assert.deepEqual(params, ['Ouvert', 5])
})

test('multi-condition OR joins with OR and preserves param order', () => {
  const { predicate, params } = buildConditionsPredicate({
    conjunction: 'OR',
    rules: [
      { column: 'status', op: 'eq', value: 'Impayée' },
      { column: 'status', op: 'in', value: ['En retard', 'Litige'] },
    ],
  })
  assert.equal(predicate, '((t.status = ?) OR (t.status IN (?,?)))')
  assert.deepEqual(params, ['Impayée', 'En retard', 'Litige'])
})

test('empty rule set is an always-false predicate', () => {
  assert.deepEqual(buildConditionsPredicate({ conjunction: 'AND', rules: [] }), {
    predicate: '1=0',
    params: [],
  })
})

test('invalid condition column is rejected (raw interpolation guard)', () => {
  assert.throws(
    () => buildConditionsPredicate({ conjunction: 'AND', rules: [{ column: 'a; DROP', op: 'eq', value: 'x' }] }),
    /Colonne de condition invalide/
  )
})

test('buildTriggerPredicate routes conditions shape through the AND/OR builder', () => {
  const { predicate, params } = buildTriggerPredicate({
    erp_table: 'tickets',
    conditions: { conjunction: 'AND', rules: [
      { column: 'status', op: 'eq', value: 'Ouvert' },
      { column: 'urgence', op: 'gte', value: 3 },
    ] },
  })
  assert.equal(predicate, '((t.status = ?) AND (CAST(t.urgence AS REAL) >= ?))')
  assert.deepEqual(params, ['Ouvert', 3])
})

test('triggerColumns collects columns from every trigger shape', () => {
  assert.deepEqual(triggerColumns({ column: 'status' }), ['status'])
  assert.deepEqual(
    triggerColumns({ conditions: { rules: [{ column: 'status' }, { column: 'urgence' }, { column: 'status' }] } }),
    ['status', 'urgence']
  )
  assert.deepEqual(
    triggerColumns({ column: 'due_date', filter: { column: 'paid' } }),
    ['due_date', 'paid']
  )
})
