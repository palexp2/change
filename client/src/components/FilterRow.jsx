import { X } from 'lucide-react'

export const OPS_BY_TYPE = {
  text: [
    { value: 'contains',     label: 'Contient' },
    { value: 'not_contains', label: 'Ne contient pas' },
    { value: 'equals',       label: 'Est égal à' },
    { value: 'not_equals',   label: "N'est pas égal à" },
    { value: 'starts_with',  label: 'Commence par' },
    { value: 'ends_with',    label: 'Finit par' },
    { value: 'is_empty',     label: 'Est vide' },
    { value: 'is_not_empty', label: "N'est pas vide" },
  ],
  single_select: [
    { value: 'equals',       label: 'Est' },
    { value: 'not_equals',   label: "N'est pas" },
    { value: 'is_any_of',    label: "Est l'un des" },
    { value: 'is_none_of',   label: "N'est aucun des" },
    { value: 'is_empty',     label: 'Est vide' },
    { value: 'is_not_empty', label: "N'est pas vide" },
  ],
  number: [
    { value: 'equals',       label: 'Est égal à' },
    { value: 'not_equals',   label: "N'est pas égal à" },
    { value: 'gt',           label: 'Supérieur à' },
    { value: 'gte',          label: 'Supérieur ou égal à' },
    { value: 'lt',           label: 'Inférieur à' },
    { value: 'lte',          label: 'Inférieur ou égal à' },
    { value: 'is_empty',     label: 'Est vide' },
    { value: 'is_not_empty', label: "N'est pas vide" },
  ],
  date: [
    { value: 'equals',              label: 'Le' },
    { value: 'before',              label: 'Avant le' },
    { value: 'after',               label: 'Après le' },
    { value: 'last_n_days',         label: 'Il y a moins de X jours' },
    { value: 'more_than_n_days_ago', label: 'Il y a plus de X jours' },
    { value: 'next_n_days',         label: 'Dans les X prochains jours' },
    { value: 'more_than_n_days_ahead', label: 'Dans plus de X jours' },
    { value: 'today',               label: "Aujourd'hui" },
    { value: 'yesterday',           label: 'Hier' },
    { value: 'this_week',           label: 'Cette semaine' },
    { value: 'this_month',          label: 'Ce mois-ci' },
    { value: 'last_month',          label: 'Le mois dernier' },
    { value: 'is_empty',            label: 'Est vide' },
    { value: 'is_not_empty',        label: "N'est pas vide" },
  ],
  boolean: [
    { value: 'is_true',  label: 'Est vrai' },
    { value: 'is_false', label: 'Est faux' },
  ],
}

export const VALUE_LESS_OPS = new Set([
  'is_empty', 'is_not_empty', 'is_true', 'is_false',
  'today', 'yesterday', 'this_week', 'this_month', 'last_month',
])
export const MULTI_SELECT_OPS = new Set(['is_any_of', 'is_none_of'])
export const DAYS_OPS = new Set(['last_n_days', 'next_n_days', 'more_than_n_days_ago', 'more_than_n_days_ahead'])
export const DATE_PICKER_OPS = new Set(['before', 'after', 'equals'])

export function getFieldType(columns, fieldValue) {
  const col = columns.find(c => c.field === fieldValue)
  return col?.type || 'text'
}

export function getFieldOptions(columns, fieldValue) {
  const col = columns.find(c => c.field === fieldValue)
  return col?.options || []
}

export function getOpsForType(type) {
  return OPS_BY_TYPE[type] || OPS_BY_TYPE.text
}

export function defaultOpForType(type) {
  if (type === 'boolean') return 'is_true'
  if (type === 'date') return 'before'
  if (type === 'number') return 'equals'
  if (type === 'single_select') return 'equals'
  return 'contains'
}

export function FilterRow({ columns, filter, onChange, onRemove, size = 'sm' }) {
  const filterableCols = columns.filter(c => c.filterable !== false && c.field)
  const fieldType = getFieldType(filterableCols, filter.field)
  const fieldOptions = getFieldOptions(filterableCols, filter.field)
  const ops = getOpsForType(fieldType)
  const needsValue = !VALUE_LESS_OPS.has(filter.op)
  const isMulti = MULTI_SELECT_OPS.has(filter.op)
  const isDays = DAYS_OPS.has(filter.op)
  const isDatePicker = DATE_PICKER_OPS.has(filter.op)

  const cls = size === 'xs' ? 'text-xs py-1.5' : 'text-sm'

  const selectedValues = isMulti
    ? (Array.isArray(filter.value) ? filter.value : (filter.value ? [filter.value] : []))
    : []

  function toggleMultiValue(opt) {
    const next = selectedValues.includes(opt)
      ? selectedValues.filter(v => v !== opt)
      : [...selectedValues, opt]
    onChange({ ...filter, value: next })
  }

  return (
    <div className="flex items-start gap-2 flex-wrap">
      <select
        value={filter.field}
        onChange={e => {
          const newType = getFieldType(filterableCols, e.target.value)
          onChange({ field: e.target.value, op: defaultOpForType(newType), value: '' })
        }}
        className={`select ${cls} flex-1 min-w-0`}
      >
        {filterableCols.map(c => <option key={c.id} value={c.field}>{c.label}</option>)}
      </select>
      <select
        value={filter.op}
        onChange={e => {
          const newOp = e.target.value
          const newVal = VALUE_LESS_OPS.has(newOp) ? '' : MULTI_SELECT_OPS.has(newOp) ? [] : (Array.isArray(filter.value) ? '' : filter.value)
          onChange({ ...filter, op: newOp, value: newVal })
        }}
        className={`select ${cls} flex-1 min-w-0`}
      >
        {ops.map(op => <option key={op.value} value={op.value}>{op.label}</option>)}
      </select>

      {needsValue && fieldType === 'single_select' && !isMulti && (
        <select value={filter.value} onChange={e => onChange({ ...filter, value: e.target.value })} className={`select ${cls} flex-1 min-w-0`}>
          <option value="">—</option>
          {fieldOptions.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      )}
      {needsValue && fieldType === 'single_select' && isMulti && (
        <div className="flex-1 min-w-0 border border-slate-200 rounded-lg bg-white max-h-40 overflow-y-auto">
          {fieldOptions.map(o => (
            <label key={o} className="flex items-center gap-2 px-3 py-1.5 hover:bg-slate-50 cursor-pointer">
              <input
                type="checkbox"
                checked={selectedValues.includes(o)}
                onChange={() => toggleMultiValue(o)}
                className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
              />
              <span className={`${size === 'xs' ? 'text-xs' : 'text-sm'} text-slate-700`}>{o}</span>
            </label>
          ))}
          {selectedValues.length > 0 && (
            <div className="px-3 py-1 border-t border-slate-100 text-xs text-slate-400">
              {selectedValues.length} sélectionné{selectedValues.length > 1 ? 's' : ''}
            </div>
          )}
        </div>
      )}
      {needsValue && fieldType === 'date' && isDatePicker && (
        <input type="date" value={filter.value} onChange={e => onChange({ ...filter, value: e.target.value })} className={`input ${cls} flex-1 min-w-0`} />
      )}
      {needsValue && fieldType === 'date' && isDays && (
        <input type="number" min="1" value={filter.value} onChange={e => onChange({ ...filter, value: e.target.value })} className={`input ${cls} flex-1 min-w-0`} placeholder="Jours" />
      )}
      {needsValue && fieldType === 'number' && (
        <input type="number" value={filter.value} onChange={e => onChange({ ...filter, value: e.target.value })} className={`input ${cls} flex-1 min-w-0`} placeholder="Valeur" />
      )}
      {needsValue && fieldType !== 'single_select' && fieldType !== 'date' && fieldType !== 'number' && fieldType !== 'boolean' && (
        <input value={filter.value} onChange={e => onChange({ ...filter, value: e.target.value })} className={`input ${cls} flex-1 min-w-0`} placeholder="Valeur" />
      )}

      <button onClick={onRemove} className="text-slate-300 hover:text-red-500 flex-shrink-0 mt-1"><X size={14} /></button>
    </div>
  )
}
