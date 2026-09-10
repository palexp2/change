import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, Search, ChevronDown } from 'lucide-react'
import { columnChoiceValues } from '../lib/customFieldDisplay.jsx'
import { linkTargetOfType } from '../lib/fieldOverrides.jsx'
import { LINKED_RECORD_TYPE_LABELS } from '../lib/tableDefs.js'
import { RatingInput } from './RatingStars.jsx'

export function FieldSelect({ columns, value, onChange, cls }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0 })
  const btnRef = useRef(null)
  const inputRef = useRef(null)

  const selected = columns.find(c => c.field === value)
  const filtered = search
    ? columns.filter(c => c.label.toLowerCase().includes(search.toLowerCase()))
    : columns

  useEffect(() => {
    if (!open) return
    // Position dropdown relative to button using fixed coords
    const rect = btnRef.current?.getBoundingClientRect()
    if (rect) setPos({ top: rect.bottom + 4, left: rect.left, width: Math.max(rect.width, 224) })
    inputRef.current?.focus()
    function handler(e) {
      if (!btnRef.current?.contains(e.target) && !document.getElementById('field-select-portal')?.contains(e.target)) {
        setOpen(false)
        setSearch('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div className="relative flex-1 min-w-0">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        className={`select ${cls} w-full flex items-center justify-between gap-1 text-left`}
      >
        <span className="truncate">{selected?.label || '—'}</span>
        <ChevronDown size={12} className="flex-shrink-0 text-slate-400" />
      </button>
      {open && createPortal(
        <div
          id="field-select-portal"
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width, zIndex: 9999 }}
          className="bg-white border border-slate-200 rounded-lg shadow-xl overflow-hidden"
        >
          <div className="p-2 border-b border-slate-100">
            <div className="relative">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                ref={inputRef}
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="w-full pl-7 pr-2 py-1.5 text-xs border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-brand-400"
              />
            </div>
          </div>
          <div className="max-h-52 overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="text-xs text-slate-400 text-center py-3">Aucun résultat</p>
            ) : filtered.map(c => (
              <button
                key={c.id}
                type="button"
                onClick={() => { onChange(c.field); setOpen(false); setSearch('') }}
                className={`w-full text-left px-3 py-2 text-xs hover:bg-slate-50 transition-colors ${c.field === value ? 'text-brand-600 font-medium bg-brand-50' : 'text-slate-700'}`}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}

// Searchable single-value picker for single_select / user filter values.
// Same portal + live-search pattern as FieldSelect, but options are plain strings.
export function ValueSelect({ options, value, onChange, cls, placeholder = '—' }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0 })
  const btnRef = useRef(null)
  const inputRef = useRef(null)

  const filtered = search
    ? options.filter(o => o.toLowerCase().includes(search.toLowerCase()))
    : options

  useEffect(() => {
    if (!open) return
    const rect = btnRef.current?.getBoundingClientRect()
    if (rect) setPos({ top: rect.bottom + 4, left: rect.left, width: Math.max(rect.width, 224) })
    inputRef.current?.focus()
    function handler(e) {
      if (!btnRef.current?.contains(e.target) && !document.getElementById('value-select-portal')?.contains(e.target)) {
        setOpen(false)
        setSearch('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div className="relative flex-1 min-w-0">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        className={`select ${cls} w-full flex items-center justify-between gap-1 text-left`}
      >
        <span className={`truncate ${value ? '' : 'text-slate-400'}`}>{value || placeholder}</span>
        <ChevronDown size={12} className="flex-shrink-0 text-slate-400" />
      </button>
      {open && createPortal(
        <div
          id="value-select-portal"
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width, zIndex: 9999 }}
          className="bg-white border border-slate-200 rounded-lg shadow-xl overflow-hidden"
        >
          <div className="p-2 border-b border-slate-100">
            <div className="relative">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                ref={inputRef}
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="w-full pl-7 pr-2 py-1.5 text-xs border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-brand-400"
              />
            </div>
          </div>
          <div className="max-h-52 overflow-y-auto">
            <button
              type="button"
              onClick={() => { onChange(''); setOpen(false); setSearch('') }}
              className={`w-full text-left px-3 py-2 text-xs hover:bg-slate-50 transition-colors ${!value ? 'text-brand-600 font-medium bg-brand-50' : 'text-slate-400'}`}
            >
              —
            </button>
            {filtered.length === 0 ? (
              <p className="text-xs text-slate-400 text-center py-3">Aucun résultat</p>
            ) : filtered.map(o => (
              <button
                key={o}
                type="button"
                onClick={() => { onChange(o); setOpen(false); setSearch('') }}
                className={`w-full text-left px-3 py-2 text-xs hover:bg-slate-50 transition-colors ${o === value ? 'text-brand-600 font-medium bg-brand-50' : 'text-slate-700'}`}
              >
                {o}
              </button>
            ))}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}

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
  // Champ lien vers une fiche : sa colonne est du texte, mais ses valeurs sont
  // une liste fermée de fiches. On propose donc les opérateurs d'une liste
  // (« est », « n'est pas », « est l'un des », « n'est aucun des ») en plus du
  // « contient » historique, utile pour une recherche partielle.
  link: [
    { value: 'equals',       label: 'Est' },
    { value: 'not_equals',   label: "N'est pas" },
    { value: 'is_any_of',    label: "Est l'un des" },
    { value: 'is_none_of',   label: "N'est aucun des" },
    { value: 'contains',     label: 'Contient' },
    { value: 'not_contains', label: 'Ne contient pas' },
    { value: 'is_empty',     label: 'Est vide' },
    { value: 'is_not_empty', label: "N'est pas vide" },
  ],
  multi_select: [
    { value: 'has_any_of',   label: "Contient l'un des" },
    { value: 'has_all_of',   label: 'Contient tous' },
    { value: 'has_none_of',  label: "Ne contient aucun des" },
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
  // Évaluation : une note se compare comme un nombre (« au moins 4 étoiles »).
  rating: [
    { value: 'equals',       label: 'Est égal à' },
    { value: 'not_equals',   label: "N'est pas égal à" },
    { value: 'gte',          label: 'Supérieur ou égal à' },
    { value: 'lte',          label: 'Inférieur ou égal à' },
    { value: 'is_empty',     label: 'Est vide' },
    { value: 'is_not_empty', label: "N'est pas vide" },
  ],
  date: [
    { value: 'equals',              label: 'Est exactement le' },
    { value: 'before',              label: 'Est avant le' },
    { value: 'after',               label: 'Est après le' },
    { value: 'between',             label: 'Est entre le' },
    { value: 'last_n_days',         label: 'Il y a moins de X jours' },
    { value: 'more_than_n_days_ago', label: 'Il y a plus de X jours' },
    { value: 'next_n_days',         label: 'Dans les X prochains jours' },
    { value: 'more_than_n_days_ahead', label: 'Dans plus de X jours' },
    { value: 'today',               label: "Est aujourd'hui" },
    { value: 'yesterday',           label: 'Est hier' },
    { value: 'this_week',           label: 'Est cette semaine' },
    { value: 'this_month',          label: 'Est ce mois-ci' },
    { value: 'last_month',          label: 'Est le mois dernier' },
    { value: 'is_empty',            label: 'Est vide' },
    { value: 'is_not_empty',        label: "N'est pas vide" },
  ],
  boolean: [
    { value: 'is_true',  label: 'Est vrai' },
    { value: 'is_false', label: 'Est faux' },
  ],
  user: [
    { value: 'is_me',        label: 'Est moi' },
    { value: 'is_not_me',    label: "N'est pas moi" },
    { value: 'equals',       label: 'Est' },
    { value: 'not_equals',   label: "N'est pas" },
    { value: 'is_any_of',    label: "Est l'un des" },
    { value: 'is_none_of',   label: "N'est aucun des" },
    { value: 'is_empty',     label: 'Est vide' },
    { value: 'is_not_empty', label: "N'est pas vide" },
  ],
}

export const VALUE_LESS_OPS = new Set([
  'is_empty', 'is_not_empty', 'is_true', 'is_false',
  'today', 'yesterday', 'this_week', 'this_month', 'last_month',
  'is_me', 'is_not_me',
])
export const MULTI_SELECT_OPS = new Set(['is_any_of', 'is_none_of', 'has_any_of', 'has_all_of', 'has_none_of'])
export const DAYS_OPS = new Set(['last_n_days', 'next_n_days', 'more_than_n_days_ago', 'more_than_n_days_ahead'])
export const DATE_PICKER_OPS = new Set(['before', 'after', 'equals'])
// Opérateurs de plage : la value est un tuple [from, to] (deux sélecteurs de date).
export const RANGE_OPS = new Set(['between'])

// Colonne « lien vers une fiche » ? Trois origines, toutes stockées en texte :
// un champ perso lien ou passé au type « Lien vers … » (`fieldType` = 'link' ou
// 'link:<table>'), une colonne à cible explicite (`linkTarget`/`linkMulti`), ou
// une colonne native qui rend déjà un lien (product_name, company_name… — même
// règle que le menu d'en-tête de DataTable).
export function isLinkColumn(col) {
  if (!col) return false
  if (col.fieldType === 'link' || linkTargetOfType(col.fieldType)) return true
  if (col.linkTarget || col.linkMulti) return true
  return !!(col.render && LINKED_RECORD_TYPE_LABELS[col.id])
}

export function getFieldType(columns, fieldValue) {
  const col = columns.find(c => c.field === fieldValue)
  const base = col?.type || 'text'
  // Un lien n'est reconnu que sur une colonne texte : un champ repassé en date
  // ou en nombre garde les opérateurs de son nouveau type.
  if (base === 'text' && isLinkColumn(col)) return 'link'
  return base
}

export function getFieldOptions(columns, fieldValue, data) {
  const col = columns.find(c => c.field === fieldValue)
  // Choix du champ, dans son ordre, quelle que soit la forme stockée (chaînes,
  // objets { id, label, color }, objet `{ choices }`) — cf. columnChoiceValues.
  const hardcoded = columnChoiceValues(col)
  // Enrich with unique values from actual data
  if (data?.length && col?.field) {
    const fromData = new Set(hardcoded)
    for (const row of data) {
      const v = row[col.field]
      if (v === null || v === undefined || v === '') continue
      if (col.type === 'multi_select') {
        // Valeurs stockées en tableau JSON — on déplie chaque label.
        let arr = v
        if (typeof v === 'string' && v.startsWith('[')) { try { arr = JSON.parse(v) } catch { arr = [] } }
        if (Array.isArray(arr)) arr.forEach(x => { if (x != null && x !== '') fromData.add(String(x)) })
        else fromData.add(String(v))
      } else {
        fromData.add(String(v))
      }
    }
    return [...fromData].sort((a, b) => a.localeCompare(b, 'fr'))
  }
  return hardcoded
}

export function getOpsForType(type) {
  return OPS_BY_TYPE[type] || OPS_BY_TYPE.text
}

// Libellé d'un opérateur, quel que soit le type qui le propose.
export function opLabel(op) {
  for (const list of Object.values(OPS_BY_TYPE)) {
    const found = list.find(o => o.value === op)
    if (found) return found.label
  }
  return op
}

// Opérateurs à afficher pour une règle : ceux du type, plus l'opérateur déjà
// enregistré s'il n'y figure pas. Une règle sauvegardée avant un changement de
// type de champ (ex. une date longtemps traitée en texte) garde ainsi un
// `<select>` qui dit la vérité, au lieu d'afficher le premier choix de la liste
// tout en filtrant sur autre chose.
export function opsForRule(type, currentOp) {
  const ops = getOpsForType(type)
  if (!currentOp || ops.some(o => o.value === currentOp)) return ops
  return [...ops, { value: currentOp, label: opLabel(currentOp) }]
}

export function defaultOpForType(type) {
  if (type === 'boolean') return 'is_true'
  if (type === 'date') return 'before'
  if (type === 'number') return 'equals'
  if (type === 'rating') return 'gte'
  if (type === 'single_select') return 'equals'
  if (type === 'multi_select') return 'has_any_of'
  if (type === 'user') return 'is_me'
  return 'contains'
}

export function FilterRow({ columns, filter, onChange, onRemove, size = 'sm', data }) {
  const filterableCols = columns.filter(c => c.filterable !== false && c.field)
  const fieldType = getFieldType(filterableCols, filter.field)
  const fieldOptions = getFieldOptions(filterableCols, filter.field, data)
  const ops = opsForRule(fieldType, filter.op)
  const needsValue = !VALUE_LESS_OPS.has(filter.op)
  const isMulti = MULTI_SELECT_OPS.has(filter.op)
  const isDays = DAYS_OPS.has(filter.op)
  const isDatePicker = DATE_PICKER_OPS.has(filter.op)
  const isRange = RANGE_OPS.has(filter.op)
  // Colonne de date portant un opérateur qui n'est pas temporel (règle
  // sauvegardée du temps où la colonne passait pour du texte) : on garde une
  // saisie libre, sinon la valeur devient invisible et inéditable.
  const isDateFreeText = fieldType === 'date' && !isDatePicker && !isDays && !isRange
  // Colonne lien : « est » / « n'est pas » se choisissent dans la liste des
  // fiches présentes ; « contient » reste une saisie libre.
  const linkPicksValue = fieldType === 'link' && (filter.op === 'equals' || filter.op === 'not_equals')

  const cls = size === 'xs' ? 'text-xs py-1.5' : 'text-sm'

  // Plage de dates : value === [from, to]. On normalise pour tolérer un ancien
  // format scalaire ou un tableau incomplet.
  const range = Array.isArray(filter.value) ? filter.value : ['', '']
  function setRange(idx, v) {
    const next = [range[0] ?? '', range[1] ?? '']
    next[idx] = v
    onChange({ ...filter, value: next })
  }

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
      <FieldSelect
        columns={filterableCols}
        value={filter.field}
        cls={cls}
        onChange={field => {
          const newType = getFieldType(filterableCols, field)
          onChange({ field, op: defaultOpForType(newType), value: '' })
        }}
      />
      <select
        value={filter.op}
        onChange={e => {
          const newOp = e.target.value
          const newVal = VALUE_LESS_OPS.has(newOp) ? '' : RANGE_OPS.has(newOp) ? ['', ''] : MULTI_SELECT_OPS.has(newOp) ? [] : (Array.isArray(filter.value) ? '' : filter.value)
          onChange({ ...filter, op: newOp, value: newVal })
        }}
        className={`select ${cls} flex-1 min-w-0`}
      >
        {ops.map(op => <option key={op.value} value={op.value}>{op.label}</option>)}
      </select>

      {needsValue && (fieldType === 'single_select' || fieldType === 'user' || linkPicksValue) && !isMulti && (
        <ValueSelect
          options={fieldOptions}
          value={filter.value}
          cls={cls}
          onChange={v => onChange({ ...filter, value: v })}
        />
      )}
      {needsValue && (fieldType === 'single_select' || fieldType === 'user' || fieldType === 'multi_select' || fieldType === 'link') && isMulti && (
        <div className="flex-1 min-w-0 border border-slate-200 rounded-lg bg-white max-h-40 overflow-y-auto">
          {fieldOptions.map(o => (
            <label key={o} className="flex items-center gap-2 px-3 py-1.5 hover:bg-slate-50 cursor-pointer">
              <input
                type="checkbox"
                checked={selectedValues.includes(o)}
                onChange={() => toggleMultiValue(o)}
                className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
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
        <input type="date" value={Array.isArray(filter.value) ? '' : (filter.value ?? '')} onChange={e => onChange({ ...filter, value: e.target.value })} className={`input ${cls} flex-1 min-w-0`} />
      )}
      {needsValue && fieldType === 'date' && isDays && (
        <input type="number" min="1" value={Array.isArray(filter.value) ? '' : (filter.value ?? '')} onChange={e => onChange({ ...filter, value: e.target.value })} className={`input ${cls} flex-1 min-w-0`} />
      )}
      {needsValue && fieldType === 'date' && isRange && (
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <input type="date" value={range[0] ?? ''} max={range[1] || undefined} onChange={e => setRange(0, e.target.value)} className={`input ${cls} flex-1 min-w-0`} />
          <span className="text-xs text-slate-400 flex-shrink-0">et</span>
          <input type="date" value={range[1] ?? ''} min={range[0] || undefined} onChange={e => setRange(1, e.target.value)} className={`input ${cls} flex-1 min-w-0`} />
        </div>
      )}
      {needsValue && fieldType === 'number' && (
        <input type="number" value={filter.value} onChange={e => onChange({ ...filter, value: e.target.value })} className={`input ${cls} flex-1 min-w-0`} />
      )}
      {/* Évaluation : le nombre d'étoiles se choisit en étoiles. */}
      {needsValue && fieldType === 'rating' && (
        <RatingInput value={filter.value} onChange={v => onChange({ ...filter, value: v })} size={15} className="flex-1 min-w-0 py-1" />
      )}
      {needsValue && !isMulti && !linkPicksValue && fieldType !== 'single_select' && fieldType !== 'multi_select' && fieldType !== 'user' && fieldType !== 'number' && fieldType !== 'rating' && fieldType !== 'boolean' && (fieldType !== 'date' || isDateFreeText) && (
        <input value={typeof filter.value === 'string' ? filter.value : ''} onChange={e => onChange({ ...filter, value: e.target.value })} className={`input ${cls} flex-1 min-w-0`} />
      )}

      <button onClick={onRemove} className="text-slate-300 hover:text-red-500 flex-shrink-0 mt-1"><X size={14} /></button>
    </div>
  )
}
