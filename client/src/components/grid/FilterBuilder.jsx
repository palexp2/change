import { useState } from 'react'
import { Plus, X } from 'lucide-react'

// ── Operator definitions ─────────────────────────────────────────────────────

const OPERATOR_LABELS = {
  is: 'est',
  is_not: "n'est pas",
  contains: 'contient',
  not_contains: 'ne contient pas',
  starts_with: 'commence par',
  ends_with: 'finit par',
  eq: '=',
  neq: '≠',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  is_empty: 'est vide',
  is_not_empty: "n'est pas vide",
  is_true: 'est coché',
  is_false: "n'est pas coché",
  is_any_of: "est l'un de",
  is_none_of: "n'est aucun de",
  has_any_of: "contient l'un de",
  has_all_of: 'contient tous',
  has_none_of: 'ne contient aucun de',
  is_exactly: 'est exactement',
  is_before: 'est avant',
  is_after: 'est après',
}

const OPERATORS_BY_TYPE = {
  text:         ['contains', 'not_contains', 'is', 'is_not', 'starts_with', 'ends_with', 'is_empty', 'is_not_empty'],
  long_text:    ['contains', 'not_contains', 'is_empty', 'is_not_empty'],
  number:       ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'is_empty', 'is_not_empty'],
  currency:     ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'is_empty', 'is_not_empty'],
  percent:      ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'is_empty', 'is_not_empty'],
  boolean:      ['is_true', 'is_false'],
  date:         ['eq', 'neq', 'is_before', 'is_after', 'is_empty', 'is_not_empty'],
  datetime:     ['eq', 'neq', 'is_before', 'is_after', 'is_empty', 'is_not_empty'],
  select:       ['is', 'is_not', 'is_any_of', 'is_none_of', 'is_empty', 'is_not_empty'],
  multi_select: ['has_any_of', 'has_all_of', 'has_none_of', 'is_exactly', 'is_empty', 'is_not_empty'],
  email:        ['contains', 'not_contains', 'is', 'is_not', 'is_empty', 'is_not_empty'],
  phone:        ['contains', 'is', 'is_not', 'is_empty', 'is_not_empty'],
  url:          ['contains', 'is', 'is_not', 'is_empty', 'is_not_empty'],
  link:         ['is_empty', 'is_not_empty'],
  attachment:   ['is_empty', 'is_not_empty'],
}

const NO_VALUE_OPS = new Set(['is_empty', 'is_not_empty', 'is_true', 'is_false'])

function defaultOp(type) {
  const ops = OPERATORS_BY_TYPE[type] || OPERATORS_BY_TYPE.text
  return ops[0]
}

// ── FilterValueInput ─────────────────────────────────────────────────────────

function FilterValueInput({ field, op, value, onChange }) {
  if (!field || NO_VALUE_OPS.has(op)) return null

  const type = field.type

  if (type === 'select' || type === 'multi_select') {
    const choices = field.options?.choices || []
    return (
      <select
        value={value || ''}
        onChange={e => onChange(e.target.value)}
        className="text-sm border border-slate-200 rounded px-2 py-1 flex-1 min-w-0 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none"
      >
        <option value="">— choisir —</option>
        {choices.map(c => (
          <option key={c.value || c.id} value={c.value || c.id}>{c.label || c.name}</option>
        ))}
      </select>
    )
  }

  if (type === 'date' || type === 'datetime') {
    return (
      <input
        type={type === 'datetime' ? 'datetime-local' : 'date'}
        value={value || ''}
        onChange={e => onChange(e.target.value)}
        className="text-sm border border-slate-200 rounded px-2 py-1 flex-1 min-w-0 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none"
      />
    )
  }

  if (type === 'number' || type === 'currency' || type === 'percent') {
    return (
      <input
        type="number"
        value={value || ''}
        onChange={e => onChange(e.target.value)}
        placeholder="Valeur"
        className="text-sm border border-slate-200 rounded px-2 py-1 flex-1 min-w-0 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none"
      />
    )
  }

  return (
    <input
      type="text"
      value={value || ''}
      onChange={e => onChange(e.target.value)}
      placeholder="Valeur"
      className="text-sm border border-slate-200 rounded px-2 py-1 flex-1 min-w-0 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none"
    />
  )
}

// ── FilterRule ───────────────────────────────────────────────────────────────

function FilterRule({ rule, fields, onChange, onRemove }) {
  const field = fields.find(f => f.key === rule.field_key)
  const operators = field ? (OPERATORS_BY_TYPE[field.type] || OPERATORS_BY_TYPE.text) : OPERATORS_BY_TYPE.text

  function setFieldKey(key) {
    const f = fields.find(f => f.key === key)
    onChange({ field_key: key, operator: defaultOp(f?.type || 'text'), value: '' })
  }

  function setOperator(op) {
    onChange({ ...rule, operator: op, value: NO_VALUE_OPS.has(op) ? '' : rule.value })
  }

  return (
    <div className="flex items-center gap-1.5 py-1 flex-wrap">
      <select
        value={rule.field_key || ''}
        onChange={e => setFieldKey(e.target.value)}
        className="text-sm border border-slate-200 rounded px-2 py-1 w-32 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none"
      >
        <option value="">Champ…</option>
        {fields.filter(f => !f.deleted_at).map(f => (
          <option key={f.key} value={f.key}>{f.name}</option>
        ))}
      </select>

      <select
        value={rule.operator || ''}
        onChange={e => setOperator(e.target.value)}
        className="text-sm border border-slate-200 rounded px-2 py-1 w-36 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none"
      >
        <option value="">Opérateur…</option>
        {operators.map(op => (
          <option key={op} value={op}>{OPERATOR_LABELS[op] || op}</option>
        ))}
      </select>

      <FilterValueInput
        field={field}
        op={rule.operator}
        value={rule.value}
        onChange={val => onChange({ ...rule, value: val })}
      />

      <button onClick={onRemove} className="text-slate-400 hover:text-red-500 p-1 shrink-0">
        <X size={13} />
      </button>
    </div>
  )
}

// ── FilterGroup ──────────────────────────────────────────────────────────────

function FilterGroup({ group, fields, onChange, onRemove, depth = 0 }) {
  function updateRule(idx, updated) {
    const rules = group.rules.map((r, i) => i === idx ? updated : r)
    onChange({ ...group, rules })
  }

  function removeRule(idx) {
    const rules = group.rules.filter((_, i) => i !== idx)
    onChange({ ...group, rules })
  }

  function addRule() {
    const firstField = fields.find(f => !f.deleted_at)
    onChange({
      ...group,
      rules: [...group.rules, { field_key: firstField?.key || '', operator: defaultOp(firstField?.type), value: '' }]
    })
  }

  function addGroup() {
    onChange({
      ...group,
      rules: [...group.rules, { conjunction: 'AND', rules: [] }]
    })
  }

  function toggleConjunction() {
    onChange({ ...group, conjunction: group.conjunction === 'AND' ? 'OR' : 'AND' })
  }

  return (
    <div className={depth > 0 ? 'ml-4 pl-3 border-l-2 border-indigo-200 mt-1' : ''}>
      {group.rules.map((rule, idx) => (
        <div key={idx}>
          {idx > 0 && (
            <button
              onClick={toggleConjunction}
              className="text-xs font-semibold text-indigo-600 hover:text-indigo-700 my-1 px-2 py-0.5 rounded bg-indigo-50 hover:bg-indigo-100"
            >
              {group.conjunction}
            </button>
          )}
          {rule.conjunction ? (
            <FilterGroup
              group={rule}
              fields={fields}
              onChange={updated => updateRule(idx, updated)}
              onRemove={() => removeRule(idx)}
              depth={depth + 1}
            />
          ) : (
            <FilterRule
              rule={rule}
              fields={fields}
              onChange={updated => updateRule(idx, updated)}
              onRemove={() => removeRule(idx)}
            />
          )}
        </div>
      ))}

      <div className="flex gap-3 mt-2">
        <button
          onClick={addRule}
          className="text-xs text-slate-500 hover:text-slate-700 flex items-center gap-1"
        >
          <Plus size={12} /> Condition
        </button>
        {depth < 2 && (
          <button
            onClick={addGroup}
            className="text-xs text-slate-500 hover:text-slate-700 flex items-center gap-1"
          >
            <Plus size={12} /> Groupe
          </button>
        )}
        {depth > 0 && (
          <button onClick={onRemove} className="text-xs text-red-500 hover:text-red-600">
            Supprimer le groupe
          </button>
        )}
      </div>
    </div>
  )
}

// ── FilterBuilder (export) ───────────────────────────────────────────────────

export function FilterBuilder({ filters, fields, onChange }) {
  const group = filters && filters.rules ? filters : { conjunction: 'AND', rules: [] }

  const activeRulesCount = countRules(group)

  function countRules(g) {
    if (!g?.rules) return 0
    return g.rules.reduce((n, r) => n + (r.conjunction ? countRules(r) : 1), 0)
  }

  return (
    <div>
      {activeRulesCount === 0 ? (
        <p className="text-sm text-slate-400 mb-3">Aucun filtre actif</p>
      ) : null}
      <FilterGroup
        group={group}
        fields={fields}
        onChange={onChange}
        onRemove={() => onChange({ conjunction: 'AND', rules: [] })}
        depth={0}
      />
    </div>
  )
}

export function filterHasRules(filters) {
  if (!filters) return false
  if (Array.isArray(filters)) return filters.length > 0
  return filters.rules?.length > 0
}
