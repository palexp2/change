import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { Eye, Filter, ArrowUpDown, Layers, X, Plus, ChevronUp, ChevronDown, Check, Search, ChevronsDownUp, ChevronsUpDown, AlertTriangle, Lock, Unlock, Pencil, Trash2, Paintbrush } from 'lucide-react'
import { useAuth } from '../lib/auth.jsx'
import { FilterRow, FieldSelect, defaultOpForType } from './FilterRow.jsx'
import { TableConfigModal } from './TableConfigModal.jsx'
import { useConfirm } from './ConfirmProvider.jsx'
import { countFilterRules } from '../lib/tableFilters.js'
import api from '../lib/api.js'

function ToolbarBtn({ icon, label, active, badge, onClick, dataPanelBtn, disabled }) {
  return (
    <button
      onClick={(e) => { if (!disabled) onClick(e) }}
      disabled={disabled}
      data-panel-btn={dataPanelBtn}
      title={disabled ? 'Vue verrouillée — déverrouillez-la pour la modifier' : undefined}
      className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition-colors ${
        disabled
          ? 'text-slate-300 cursor-not-allowed'
          : active ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-100'
      }`}
    >
      {icon}
      {label}
      {badge > 0 && (
        <span className="bg-brand-600 text-white rounded-full w-4 h-4 flex items-center justify-center text-[10px] leading-none">
          {badge}
        </span>
      )}
    </button>
  )
}

// Rendu via portal dans <body> en position fixed : les panneaux ne sont plus
// clippés par le `overflow-hidden` du card DataTable (problème visible quand la
// fenêtre / le tableau est très petit). Position clampée au viewport
// (horizontal + hauteur max) et recalculée sur scroll/resize.
function Panel({ children, className = '', anchorEl }) {
  const ref = useRef(null)
  const [pos, setPos] = useState(null)

  useLayoutEffect(() => {
    function place() {
      const el = ref.current
      const btnRect = anchorEl?.getBoundingClientRect()
      if (!el || !btnRect) return
      const margin = 8
      const width = el.offsetWidth
      let left = btnRect.left
      if (left + width > window.innerWidth - margin) {
        left = Math.max(margin, window.innerWidth - width - margin)
      }
      const top = btnRect.bottom + 4
      const maxHeight = Math.max(160, window.innerHeight - top - margin)
      setPos({ top, left, maxHeight })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [anchorEl])

  return createPortal(
    <div
      ref={ref}
      data-viewtoolbar-panel
      style={{
        position: 'fixed',
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        maxHeight: pos?.maxHeight,
        zIndex: 9998, // sous les portals FieldSelect/ValueSelect (9999)
      }}
      className={`bg-white border border-slate-200 rounded-lg shadow-xl p-4 overflow-y-auto ${className}`}
    >
      {children}
    </div>,
    document.body
  )
}

function PanelTitle({ children }) {
  return <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">{children}</p>
}

export function FieldsPanel({ columns, visibleCols, onChange, anchorEl }) {
  const [search, setSearch] = useState('')
  const filtered = search
    ? columns.filter(c => c.label.toLowerCase().includes(search.toLowerCase()))
    : columns

  const filteredIds = filtered.map(c => c.id)
  const allVisible = filteredIds.every(id => visibleCols.includes(id))
  const noneVisible = filteredIds.every(id => !visibleCols.includes(id))

  function showAll() {
    onChange(v => Array.from(new Set([...v, ...filteredIds])))
  }
  function hideAll() {
    const hideSet = new Set(filteredIds)
    onChange(v => v.filter(id => !hideSet.has(id)))
  }

  return (
    <Panel className="w-64" anchorEl={anchorEl}>
      <PanelTitle>Colonnes visibles</PanelTitle>
      <div className="relative mb-2">
        <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full pl-7 pr-2 py-1.5 text-xs border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-brand-400"
          placeholder="Rechercher..."
          autoFocus
        />
      </div>
      <div className="space-y-0.5 max-h-64 overflow-y-auto">
        {filtered.length === 0
          ? <p className="text-xs text-slate-400 text-center py-2">Aucun résultat</p>
          : filtered.map(col => (
          <label key={col.id} className="flex items-center gap-2.5 px-1 py-1.5 rounded hover:bg-slate-50 cursor-pointer">
            <input
              type="checkbox"
              checked={visibleCols.includes(col.id)}
              onChange={e => {
                if (e.target.checked) onChange(v => [...v, col.id])
                else onChange(v => v.filter(id => id !== col.id))
              }}
              className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
            />
            <span className="text-sm text-slate-700">{col.label}</span>
          </label>
        ))}
      </div>
      {filtered.length > 0 && (
        <div className="mt-2 pt-2 border-t border-slate-100 flex items-center gap-1.5">
          <button
            type="button"
            onClick={showAll}
            disabled={allVisible}
            className="flex-1 text-xs font-medium text-slate-600 hover:text-brand-700 hover:bg-brand-50 rounded px-2 py-1.5 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-slate-600 disabled:cursor-not-allowed"
          >
            Tout voir
          </button>
          <button
            type="button"
            onClick={hideAll}
            disabled={noneVisible}
            className="flex-1 text-xs font-medium text-slate-600 hover:text-brand-700 hover:bg-brand-50 rounded px-2 py-1.5 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-slate-600 disabled:cursor-not-allowed"
          >
            Tout cacher
          </button>
        </div>
      )}
    </Panel>
  )
}

// Profondeur d'imbrication max des groupes de filtres. Le moteur SQL serveur
// (buildGroupSQL) plafonne à 3 ; on reste sous cette limite côté UI. depth 0 =
// groupe racine, donc on autorise « Ajouter un groupe » tant que depth < 2
// (→ deux niveaux de parenthèses imbriquées, largement suffisant et sûr).
const MAX_FILTER_GROUP_DEPTH = 2

function isGroupNode(node) {
  return !!(node && node.conjunction && Array.isArray(node.rules))
}

function emptyRule(filterableCols) {
  const first = filterableCols[0]
  const type = first?.type || 'text'
  return { field: first?.field ?? '', op: defaultOpForType(type), value: '' }
}

// Bascule ET / OU compacte appliquée aux enfants directs d'un groupe.
function ConjunctionToggle({ value, onChange }) {
  return (
    <div className="flex items-center gap-0.5 bg-slate-100 rounded p-0.5">
      <button onClick={() => onChange('AND')}
        className={`text-xs px-2.5 py-1 rounded transition-colors font-medium ${value === 'AND' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
        ET
      </button>
      <button onClick={() => onChange('OR')}
        className={`text-xs px-2.5 py-1 rounded transition-colors font-medium ${value === 'OR' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
        OU
      </button>
    </div>
  )
}

// Éditeur récursif d'un groupe de filtres : ses enfants sont soit des règles
// feuilles (FilterRow), soit des sous-groupes (parenthèses) eux-mêmes rendus
// par ce composant. La conjonction (ET/OU) s'applique aux enfants directs.
function FilterGroupEditor({ group, onChange, onRemove, columns, filterableCols, data, disabledColumns, depth }) {
  const conjunction = group.conjunction === 'OR' ? 'OR' : 'AND'
  const rules = group.rules || []
  const isDisabledField = (fieldName) => !!(disabledColumns && fieldName && disabledColumns.has(fieldName))

  function setConjunction(c) { onChange({ ...group, conjunction: c }) }
  function updateChild(i, child) { onChange({ ...group, rules: rules.map((r, idx) => idx === i ? child : r) }) }
  function removeChild(i) { onChange({ ...group, rules: rules.filter((_, idx) => idx !== i) }) }
  function addRule() { onChange({ ...group, rules: [...rules, emptyRule(filterableCols)] }) }
  function addGroup() {
    onChange({ ...group, rules: [...rules, { conjunction: 'AND', rules: [emptyRule(filterableCols)] }] })
  }

  const nested = depth > 0
  return (
    <div data-filter-group={depth} className={nested ? 'rounded-lg border border-slate-200 bg-slate-50/70 p-2' : ''}>
      <div className="flex items-center justify-between mb-2">
        {rules.length > 1
          ? <ConjunctionToggle value={conjunction} onChange={setConjunction} />
          : <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">{nested ? 'Groupe' : ''}</span>}
        {nested && (
          <button onClick={onRemove} className="text-slate-300 hover:text-red-500 flex-shrink-0" title="Retirer ce groupe">
            <X size={14} />
          </button>
        )}
      </div>

      <div className="space-y-1">
        {rules.length === 0 && (
          <p className="text-sm text-slate-400 py-1">Aucun filtre actif</p>
        )}
        {rules.map((child, i) => {
          const childIsGroup = isGroupNode(child)
          const fieldName = childIsGroup ? null : (child.field_key || child.field)
          const broken = fieldName ? isDisabledField(fieldName) : false
          return (
            <div key={i}>
              {i > 0 && (
                <div className="flex items-center gap-2 my-1.5">
                  <div className="flex-1 h-px bg-slate-100" />
                  <span className="text-[10px] font-bold text-slate-400 tracking-wide">{conjunction === 'OR' ? 'OU' : 'ET'}</span>
                  <div className="flex-1 h-px bg-slate-100" />
                </div>
              )}
              {childIsGroup ? (
                <FilterGroupEditor
                  group={child}
                  onChange={c => updateChild(i, c)}
                  onRemove={() => removeChild(i)}
                  columns={columns}
                  filterableCols={filterableCols}
                  data={data}
                  disabledColumns={disabledColumns}
                  depth={depth + 1}
                />
              ) : (
                <>
                  <FilterRow
                    columns={columns}
                    filter={child}
                    onChange={updated => updateChild(i, updated)}
                    onRemove={() => removeChild(i)}
                    size="xs"
                    data={data}
                  />
                  {broken && (
                    <div className="flex items-start gap-1 mt-0.5 ml-1 text-[11px] text-amber-700">
                      <AlertTriangle size={11} className="mt-0.5 flex-shrink-0" />
                      <span>Le champ <code className="font-mono">{fieldName}</code> a été désactivé dans la sync Airtable. Ce filtre ne renverra plus rien — supprime-le ou change le champ.</span>
                    </div>
                  )}
                </>
              )}
            </div>
          )
        })}
      </div>

      <div className="mt-3 flex items-center gap-4">
        <button onClick={addRule} className="flex items-center gap-1.5 text-xs text-brand-600 hover:text-brand-800 font-medium">
          <Plus size={13} /> Ajouter un filtre
        </button>
        {depth < MAX_FILTER_GROUP_DEPTH && (
          <button onClick={addGroup} className="flex items-center gap-1.5 text-xs text-brand-600 hover:text-brand-800 font-medium" title="Regrouper des conditions entre parenthèses">
            <Plus size={13} /> Ajouter un groupe
          </button>
        )}
      </div>
    </div>
  )
}

// ── Formatage conditionnel (règles de couleur par vue, à la Airtable) ────────
// Teintes de fond + barre latérale appliquées aux lignes du DataTable. Les clés
// sont persistées dans table_view_pills.color_rules ; les valeurs restent côté
// client pour pouvoir ajuster la palette sans migration.
export const ROW_COLOR_STYLES = {
  red:    { bg: '#fef2f2', bar: '#f87171', label: 'Rouge' },
  orange: { bg: '#fff7ed', bar: '#fb923c', label: 'Orange' },
  yellow: { bg: '#fefce8', bar: '#facc15', label: 'Jaune' },
  green:  { bg: '#f0fdf4', bar: '#4ade80', label: 'Vert' },
  teal:   { bg: '#f0fdfa', bar: '#2dd4bf', label: 'Sarcelle' },
  blue:   { bg: '#eff6ff', bar: '#60a5fa', label: 'Bleu' },
  purple: { bg: '#faf5ff', bar: '#c084fc', label: 'Violet' },
  pink:   { bg: '#fdf2f8', bar: '#f472b6', label: 'Rose' },
  gray:   { bg: '#f8fafc', bar: '#94a3b8', label: 'Gris' },
}

function newColorRule(filterableCols, usedColors) {
  // Prend la première couleur de la palette pas encore utilisée (sinon rouge).
  const color = Object.keys(ROW_COLOR_STYLES).find(c => !usedColors.has(c)) || 'red'
  return {
    id: `cr_${Math.random().toString(36).slice(2, 10)}`,
    color,
    filters: { conjunction: 'AND', rules: [emptyRule(filterableCols)] },
  }
}

// Une règle de couleur : swatch picker + conditions (mêmes FilterRow/groupes que
// le panneau Filtrer). L'ordre des règles compte : la première qui matche gagne.
function ColorRuleCard({ rule, index, total, onChange, onRemove, onMove, columns, filterableCols, data, disabledColumns }) {
  const normalized = Array.isArray(rule.filters)
    ? { conjunction: 'AND', rules: rule.filters }
    : (rule.filters?.rules ? rule.filters : { conjunction: 'AND', rules: [] })
  return (
    <div data-color-rule={index} className="rounded-lg border border-slate-200 bg-white p-2.5">
      <div className="flex items-center gap-1.5 mb-2">
        <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide flex-shrink-0">Règle {index + 1}</span>
        <div className="flex items-center gap-1 ml-1 flex-wrap">
          {Object.entries(ROW_COLOR_STYLES).map(([key, c]) => (
            <button
              key={key}
              type="button"
              data-color-swatch={key}
              onClick={() => onChange({ ...rule, color: key })}
              title={c.label}
              aria-label={c.label}
              className={`h-5 w-5 rounded-full border transition-transform ${
                rule.color === key ? 'ring-2 ring-offset-1 ring-brand-500 border-transparent scale-110' : 'border-slate-200 hover:scale-110'
              }`}
              style={{ background: c.bar }}
            />
          ))}
        </div>
        <div className="ml-auto flex items-center gap-0.5 flex-shrink-0">
          <button
            onClick={() => onMove(index, -1)}
            disabled={index === 0}
            className="p-0.5 text-slate-400 hover:text-slate-700 disabled:opacity-30 disabled:hover:text-slate-400"
            title="Monter (priorité plus forte)"
          >
            <ChevronUp size={13} />
          </button>
          <button
            onClick={() => onMove(index, 1)}
            disabled={index === total - 1}
            className="p-0.5 text-slate-400 hover:text-slate-700 disabled:opacity-30 disabled:hover:text-slate-400"
            title="Descendre (priorité plus faible)"
          >
            <ChevronDown size={13} />
          </button>
          <button onClick={onRemove} className="p-0.5 text-slate-300 hover:text-red-500" title="Supprimer cette règle">
            <X size={14} />
          </button>
        </div>
      </div>
      <FilterGroupEditor
        group={normalized}
        onChange={g => onChange({ ...rule, filters: g })}
        columns={columns}
        filterableCols={filterableCols}
        data={data}
        disabledColumns={disabledColumns}
        depth={0}
      />
    </div>
  )
}

function ColorPanel({ columns, rules, onChange, data, anchorEl, disabledColumns }) {
  const filterableCols = columns.filter(c => c.filterable !== false && c.field)
  const list = Array.isArray(rules) ? rules : []

  function addRule() {
    onChange([...list, newColorRule(filterableCols, new Set(list.map(r => r.color)))])
  }
  function updateRule(i, next) { onChange(list.map((r, idx) => idx === i ? next : r)) }
  function removeRule(i) { onChange(list.filter((_, idx) => idx !== i)) }
  function moveRule(i, delta) {
    const tgt = i + delta
    if (tgt < 0 || tgt >= list.length) return
    const next = [...list]
    ;[next[i], next[tgt]] = [next[tgt], next[i]]
    onChange(next)
  }

  return (
    <Panel className="w-[560px] max-w-[calc(100vw-16px)]" anchorEl={anchorEl}>
      <PanelTitle>Couleur des lignes</PanelTitle>
      <div data-testid="color-rules-panel" className="max-h-[60vh] overflow-y-auto space-y-2">
        {list.length === 0 && (
          <p className="text-sm text-slate-400 py-1">
            Aucune règle de couleur — ajoutez-en une pour colorer les lignes selon leurs valeurs.
          </p>
        )}
        {list.map((rule, i) => (
          <ColorRuleCard
            key={rule.id || i}
            rule={rule}
            index={i}
            total={list.length}
            onChange={next => updateRule(i, next)}
            onRemove={() => removeRule(i)}
            onMove={moveRule}
            columns={columns}
            filterableCols={filterableCols}
            data={data}
            disabledColumns={disabledColumns}
          />
        ))}
      </div>
      <div className="mt-3 flex items-center justify-between gap-3">
        <button onClick={addRule} className="flex items-center gap-1.5 text-xs text-brand-600 hover:text-brand-800 font-medium">
          <Plus size={13} /> Ajouter une règle
        </button>
        {list.length > 1 && (
          <span className="text-[10px] text-slate-400">La première règle qui correspond colore la ligne.</span>
        )}
      </div>
    </Panel>
  )
}

function FilterPanel({ columns, filters, onChange, data, anchorEl, disabledColumns }) {
  const filterableCols = columns.filter(c => c.filterable !== false && c.field)

  // Normalize to {conjunction, rules} format (le format plat array reste accepté
  // en lecture pour les vues legacy ; toute édition repasse en format imbriqué).
  const normalized = Array.isArray(filters)
    ? { conjunction: 'AND', rules: filters }
    : (filters?.rules ? filters : { conjunction: 'AND', rules: [] })

  return (
    <Panel className="w-[560px] max-w-[calc(100vw-16px)]" anchorEl={anchorEl}>
      <PanelTitle>Filtres</PanelTitle>
      <div className="max-h-[60vh] overflow-y-auto">
        <FilterGroupEditor
          group={normalized}
          onChange={onChange}
          columns={columns}
          filterableCols={filterableCols}
          data={data}
          disabledColumns={disabledColumns}
          depth={0}
        />
      </div>
    </Panel>
  )
}

function SortPanel({ columns, sorts, onChange, anchorEl, disabledColumns }) {
  const isDisabledField = (fieldName) => !!(disabledColumns && fieldName && disabledColumns.has(fieldName))
  function add() {
    const used = new Set(sorts.map(s => s.field))
    const next = columns.find(c => !used.has(c.field))
    if (!next) return
    onChange(s => [...s, { field: next.field, dir: 'asc' }])
  }
  function update(i, patch) {
    onChange(s => s.map((item, idx) => idx === i ? { ...item, ...patch } : item))
  }
  function remove(i) {
    onChange(s => s.filter((_, idx) => idx !== i))
  }

  return (
    <Panel className="w-80" anchorEl={anchorEl}>
      <PanelTitle>Trier par</PanelTitle>
      <div className="space-y-2 max-h-60 overflow-y-auto">
        {sorts.length === 0 && <p className="text-sm text-slate-400 py-1">Aucun tri actif</p>}
        {sorts.map((s, i) => {
          const broken = isDisabledField(s.field)
          // Si le tri référence un champ désactivé, on l'ajoute en option "ghost"
          // pour que le select puisse afficher la valeur courante.
          const optionsForRow = broken
            ? [{ id: `__broken_${s.field}`, field: s.field, label: s.field }, ...columns]
            : columns
          return (
            <div key={i}>
              <div className="flex items-center gap-2">
                <FieldSelect
                  columns={optionsForRow}
                  value={s.field}
                  onChange={f => update(i, { field: f })}
                  cls="text-xs py-1.5"
                />
                <button onClick={() => update(i, { dir: s.dir === 'asc' ? 'desc' : 'asc' })} className="flex items-center gap-1 px-2.5 py-1.5 text-xs border border-slate-200 rounded hover:bg-slate-50 flex-shrink-0 text-slate-600">
                  {s.dir === 'asc' ? <><ChevronUp size={12} /> Croissant</> : <><ChevronDown size={12} /> Décroissant</>}
                </button>
                <button onClick={() => remove(i)} className="text-slate-300 hover:text-red-500 flex-shrink-0"><X size={14} /></button>
              </div>
              {broken && (
                <div className="flex items-start gap-1 mt-0.5 ml-1 text-[11px] text-amber-700">
                  <AlertTriangle size={11} className="mt-0.5 flex-shrink-0" />
                  <span>Le champ <code className="font-mono">{s.field}</code> a été désactivé dans la sync Airtable. Ce tri n'a plus d'effet.</span>
                </div>
              )}
            </div>
          )
        })}
      </div>
      <button onClick={add} className="mt-3 flex items-center gap-1.5 text-xs text-brand-600 hover:text-brand-800 font-medium">
        <Plus size={13} /> Ajouter un tri
      </button>
    </Panel>
  )
}

// Panel de groupage multi-niveau. `groupBy` est un array de field names :
// chaque entrée = un niveau de groupage imbriqué (niveau 0 = parent). Compat
// legacy : accepte aussi `null` ou string single-level, normalisé en array.
// `groupOrder` est un array aligné sur `groupBy` (orders par niveau).
function GroupPanel({ columns, groupBy, onChange, groupOrder, setGroupOrder, onCollapseAll, onExpandAll, anchorEl, disabledColumns }) {
  const [search, setSearch] = useState('')
  const groupByArr = Array.isArray(groupBy) ? groupBy : (groupBy ? [groupBy] : [])
  const groupOrderArr = Array.isArray(groupOrder) ? groupOrder : (groupOrder ? [groupOrder] : [])
  const usedFields = new Set(groupByArr)

  const available = columns.filter(c => !usedFields.has(c.field))
  const filtered = search
    ? available.filter(c => c.label.toLowerCase().includes(search.toLowerCase()))
    : available

  function addLevel(field) {
    onChange([...groupByArr, field])
    setSearch('')
  }
  function removeLevel(idx) {
    onChange(groupByArr.filter((_, i) => i !== idx))
    if (setGroupOrder) setGroupOrder(groupOrderArr.filter((_, i) => i !== idx))
  }
  function moveLevel(idx, delta) {
    const tgt = idx + delta
    if (tgt < 0 || tgt >= groupByArr.length) return
    const next = [...groupByArr]
    ;[next[idx], next[tgt]] = [next[tgt], next[idx]]
    onChange(next)
    if (setGroupOrder) {
      const o = [...groupOrderArr]
      while (o.length < groupByArr.length) o.push(null)
      ;[o[idx], o[tgt]] = [o[tgt], o[idx]]
      setGroupOrder(o)
    }
  }
  function setLevelOrder(idx, order) {
    if (!setGroupOrder) return
    const next = [...groupOrderArr]
    while (next.length <= idx) next.push(null)
    next[idx] = order
    setGroupOrder(next)
  }
  function clearAll() {
    onChange([])
    if (setGroupOrder) setGroupOrder([])
  }

  function orderBtnCls(active) {
    return `flex items-center gap-1 flex-1 justify-center px-1.5 py-0.5 text-[10px] rounded border transition-colors ${
      active ? 'bg-brand-50 text-brand-700 border-brand-200' : 'text-slate-500 hover:bg-slate-100 border-slate-200'
    }`
  }

  return (
    <Panel className="w-72" anchorEl={anchorEl}>
      <PanelTitle>Grouper par</PanelTitle>

      {groupByArr.length > 0 && (
        <div className="mb-3 space-y-1.5">
          {groupByArr.map((field, idx) => {
            const col = columns.find(c => c.field === field)
            const broken = !!(disabledColumns && disabledColumns.has(field))
            const order = groupOrderArr[idx] || null
            const hasOpts = Array.isArray(col?.options) && col.options.length > 0
            return (
              <div key={`${field}-${idx}`} className="bg-slate-50 border border-slate-200 rounded p-1.5">
                <div className="flex items-center gap-1">
                  <span className="text-[10px] font-semibold text-slate-400 w-7 flex-shrink-0">N°{idx + 1}</span>
                  <span className="flex-1 truncate text-xs font-medium text-slate-700">
                    {col?.label || field}
                  </span>
                  <button
                    onClick={() => moveLevel(idx, -1)}
                    disabled={idx === 0}
                    className="p-0.5 text-slate-400 hover:text-slate-700 disabled:opacity-30 disabled:hover:text-slate-400"
                    title="Monter d'un niveau"
                  >
                    <ChevronUp size={12} />
                  </button>
                  <button
                    onClick={() => moveLevel(idx, 1)}
                    disabled={idx === groupByArr.length - 1}
                    className="p-0.5 text-slate-400 hover:text-slate-700 disabled:opacity-30 disabled:hover:text-slate-400"
                    title="Descendre d'un niveau"
                  >
                    <ChevronDown size={12} />
                  </button>
                  <button
                    onClick={() => removeLevel(idx)}
                    className="p-0.5 text-slate-400 hover:text-rose-600"
                    title="Retirer ce niveau"
                  >
                    <X size={12} />
                  </button>
                </div>
                {broken && (
                  <div className="flex items-start gap-1 mt-1 text-[10px] text-amber-700">
                    <AlertTriangle size={10} className="mt-0.5 flex-shrink-0" />
                    <span>Champ désactivé dans la sync Airtable</span>
                  </div>
                )}
                {setGroupOrder && (
                  <div className="flex items-center gap-1 mt-1">
                    {hasOpts && (
                      <button
                        onClick={() => setLevelOrder(idx, 'default')}
                        className={orderBtnCls(order === 'default' || order == null)}
                        title={`Ordre des options (${col.options.slice(0, 3).join(', ')}${col.options.length > 3 ? '…' : ''})`}
                      >
                        Défaut
                      </button>
                    )}
                    <button
                      onClick={() => setLevelOrder(idx, 'asc')}
                      className={orderBtnCls(order === 'asc' || (order == null && !hasOpts))}
                      title="Tri alphabétique croissant"
                    >
                      <ChevronUp size={10} /> A → Z
                    </button>
                    <button
                      onClick={() => setLevelOrder(idx, 'desc')}
                      className={orderBtnCls(order === 'desc')}
                      title="Tri alphabétique décroissant"
                    >
                      <ChevronDown size={10} /> Z → A
                    </button>
                  </div>
                )}
              </div>
            )
          })}
          <div className="flex items-center gap-1">
            <button onClick={onExpandAll} className="flex items-center gap-1 flex-1 justify-center px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-100 rounded border border-slate-200 transition-colors">
              <ChevronsUpDown size={11} /> Tout ouvrir
            </button>
            <button onClick={onCollapseAll} className="flex items-center gap-1 flex-1 justify-center px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-100 rounded border border-slate-200 transition-colors">
              <ChevronsDownUp size={11} /> Tout fermer
            </button>
          </div>
          <button onClick={clearAll} className="w-full px-2 py-1 text-[11px] text-rose-600 hover:bg-rose-50 rounded border border-slate-200">
            Tout retirer
          </button>
        </div>
      )}

      <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1">
        {groupByArr.length === 0 ? 'Choisir un champ' : 'Ajouter un niveau'}
      </div>
      <div className="relative mb-2">
        <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full pl-7 pr-2 py-1.5 text-xs border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-brand-400"
          placeholder="Rechercher..."
          autoFocus
        />
      </div>
      <div className="space-y-0.5 max-h-60 overflow-y-auto">
        {filtered.length === 0
          ? <p className="text-xs text-slate-400 text-center py-2">{available.length === 0 ? 'Tous les champs sont utilisés' : 'Aucun résultat'}</p>
          : filtered.map(col => (
            <button
              key={col.id}
              onClick={() => addLevel(col.field)}
              className="flex items-center justify-between w-full px-2 py-1.5 rounded text-sm text-left transition-colors hover:bg-slate-50 text-slate-600"
            >
              {col.label}
              <Plus size={13} className="text-slate-400" />
            </button>
          ))}
      </div>
    </Panel>
  )
}

export function ViewToolbar({
  table,
  columns,
  sorts, setSorts,
  filters, setFilters,
  search, setSearch,
  searchFields = [],
  views = [],
  onReorderViews,
  activeViewId,
  setActiveViewId,
  patchLocalView,
  processedCount,
  visibleCols, setVisibleCols,
  groupBy, setGroupBy,
  groupOrder, setGroupOrder,
  colorRules, setColorRules,
  onCollapseAll, onExpandAll,
  data,
  disabledColumns = null,
  manageViews = false,
  manageViewsBulkDelete = false,
}) {
  const [openPanel, setOpenPanel] = useState(null)
  // Élément bouton servant d'ancre au panneau (rendu en portal position:fixed).
  const [panelAnchor, setPanelAnchor] = useState(null)
  const toolbarRef = useRef(null)

  function togglePanel(name, e) {
    if (openPanel === name) { setOpenPanel(null); return }
    const btn = e?.currentTarget
    if (btn) setPanelAnchor(btn)
    setOpenPanel(name)
  }
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const confirm = useConfirm()

  // Menu contextuel (clic droit, admin) sur un onglet de vue : renommer,
  // verrouiller/déverrouiller, supprimer — mêmes actions que la modale
  // « Gérer les vues » (crayon), sans avoir à l'ouvrir.
  // { x, y, viewId } + { renaming: true, name } en mode renommage inline.
  const [viewMenu, setViewMenu] = useState(null)

  // Vue verrouillée (lecture seule) : ses filtres/tris/colonnes ne peuvent pas
  // dériver. On désactive les panneaux de config et on bloque l'autosave.
  // Un ref garde la valeur fraîche pour les closures d'autosave (flushSave).
  const activeViewLocked = !!views.find(v => v.id === activeViewId)?.locked
  const lockedRef = useRef(activeViewLocked)
  lockedRef.current = activeViewLocked

  // Actions du menu contextuel de vue. Après chaque mutation, l'événement
  // `views:updated` force useTableView à recharger les pills (même mécanisme
  // que TableConfigModal).
  async function renameViewFromMenu() {
    const m = viewMenu
    const v = views.find(x => x.id === m?.viewId)
    const name = m?.name?.trim()
    setViewMenu(null)
    if (!v || !name || name === v.label) return
    try {
      await api.views.updatePill(table, v.id, { label: name })
      window.dispatchEvent(new CustomEvent('views:updated', { detail: { table } }))
    } catch {}
  }

  async function toggleViewLockFromMenu(v) {
    setViewMenu(null)
    try {
      await api.views.setPillLocked(table, v.id, !v.locked)
      window.dispatchEvent(new CustomEvent('views:updated', { detail: { table } }))
    } catch {}
  }

  async function deleteViewFromMenu(v) {
    setViewMenu(null)
    if (!(await confirm(`Supprimer la vue « ${v.label} » ?`))) return
    try {
      await api.views.deletePill(table, v.id)
      window.dispatchEvent(new CustomEvent('views:updated', { detail: { table } }))
    } catch {}
  }

  // Bouton « + » de la barre des vues (admin) : crée une vue vide et l'active
  // aussitôt. Le renommage / verrouillage / suppression se font ensuite par
  // clic droit sur l'onglet — plus besoin d'une modale « Gérer les vues ».
  async function createViewInline() {
    try {
      const pill = await api.views.createPill(table, {
        label: `Vue ${views.length + 1}`,
        color: 'blue',
        filters: [],
        visible_columns: [],
        sort: [],
        group_by: null,
        sort_order: views.length,
      })
      setActiveViewId?.(pill.id)
      window.dispatchEvent(new CustomEvent('views:updated', { detail: { table } }))
    } catch {}
  }

  const [draggingId, _setDraggingId] = useState(null)
  const draggingIdRef = useRef(null)
  function setDraggingId(v) { draggingIdRef.current = v; _setDraggingId(v) }
  const [dragPreview, _setDragPreview] = useState(null)
  const dragPreviewRef = useRef(null)
  function setDragPreview(v) { dragPreviewRef.current = v; _setDragPreview(v) }
  const tabsRef = useRef(null)
  const tabElsRef = useRef({})
  const flipRectsRef = useRef({})

  // Liste des onglets : uniquement les pills réelles. La vue virtuelle « Tous »
  // a été retirée — toutes les vues sont des pills configurables et supprimables.
  const mergedViews = views
    .map((v, i) => ({ ...v, __sortOrder: v.sort_order ?? i }))
    .sort((a, b) => a.__sortOrder - b.__sortOrder)

  const displayViews = dragPreview || mergedViews

  function captureRects() {
    const rects = {}
    for (const [id, el] of Object.entries(tabElsRef.current)) {
      if (el) rects[id] = el.getBoundingClientRect()
    }
    flipRectsRef.current = rects
  }

  // FLIP animation after reorder
  useLayoutEffect(() => {
    const prev = flipRectsRef.current
    if (!Object.keys(prev).length) return
    flipRectsRef.current = {}
    for (const [id, el] of Object.entries(tabElsRef.current)) {
      if (!el || !prev[id]) continue
      if (id === draggingIdRef.current) continue
      const newRect = el.getBoundingClientRect()
      const dx = prev[id].left - newRect.left
      if (Math.abs(dx) < 1) continue
      el.style.transform = `translateX(${dx}px)`
      el.style.transition = 'none'
      el.offsetHeight
      el.style.transition = 'transform 150ms ease'
      el.style.transform = ''
    }
  })

  // Auto-save view on any change (filters, sorts, visible columns, group by)
  const autoSaveRef = useRef(null)
  const pendingSaveRef = useRef(null)
  const flushSaveRef = useRef(null)

  function flushSave() {
    // Vue verrouillée : on n'écrit jamais (le serveur refuserait en 423).
    if (lockedRef.current) { pendingSaveRef.current = null; return }
    const p = pendingSaveRef.current
    if (!p) return
    pendingSaveRef.current = null
    clearTimeout(autoSaveRef.current)
    // group_by / group_order : envoyer null si vide pour éviter de stocker
    // des arrays vides ; sinon, envoyer tel quel — le serveur encode les
    // arrays en JSON et accepte aussi les strings (legacy single-level).
    const normGroupBy = Array.isArray(p.groupBy)
      ? (p.groupBy.length > 0 ? p.groupBy : null)
      : (p.groupBy || null)
    const normGroupOrder = Array.isArray(p.groupOrder)
      ? (p.groupOrder.length > 0 ? p.groupOrder : null)
      : (p.groupOrder || null)
    const payload = {
      sort: p.sorts,
      filters: p.filters || [],
      visible_columns: p.visibleCols || [],
      group_by: normGroupBy,
      group_order: normGroupOrder,
    }
    // color_rules : envoyé seulement si la feature est câblée sur cette table
    // (prop fournie) — sinon on écraserait les règles existantes avec [].
    if (p.colorRules !== undefined) payload.color_rules = p.colorRules || []
    api.views.updatePill(p.table, p.viewId, payload).catch(() => {})
    // Sync l'état local — sinon, au retour sur cette vue après en avoir
    // visité une autre, on relit la version pré-drag du `views` state et
    // l'autosave qui suit écrase la sauvegarde qu'on vient de faire.
    patchLocalView?.(p.viewId, payload)
  }
  flushSaveRef.current = flushSave

  const prevActiveViewIdRef = useRef(activeViewId)
  useEffect(() => {
    if (prevActiveViewIdRef.current && prevActiveViewIdRef.current !== activeViewId) {
      flushSaveRef.current()
    }
    prevActiveViewIdRef.current = activeViewId
  }, [activeViewId])

  useEffect(() => {
    if (!table) return
    if (activeViewId) {
      if (lockedRef.current) return // vue verrouillée : pas d'autosave
      pendingSaveRef.current = { table, viewId: activeViewId, sorts, filters, visibleCols, groupBy, groupOrder, colorRules }
      clearTimeout(autoSaveRef.current)
      autoSaveRef.current = setTimeout(() => flushSaveRef.current(), 600)
    } else if (visibleCols && visibleCols.length > 0) {
      try { localStorage.setItem(`erp_allView_cols_${table}`, JSON.stringify(visibleCols)) } catch {}
    }
  }, [table, activeViewId, sorts, filters, visibleCols, groupBy, groupOrder, colorRules])

  useEffect(() => {
    function onBeforeUnload() { flushSaveRef.current() }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      flushSaveRef.current()
    }
  }, [])


  // Vue verrouillée : fermer tout panneau de config ouvert (ex. ouvert avant
  // le verrouillage, ou via le clic-droit d'un header DataTable).
  useEffect(() => {
    if (activeViewLocked) setOpenPanel(null)
  }, [activeViewLocked])

  useEffect(() => {
    if (!openPanel) return
    function handler(e) {
      if (toolbarRef.current && !toolbarRef.current.contains(e.target) && !e.target.closest?.('[data-viewtoolbar-panel]') && !document.getElementById('field-select-portal')?.contains(e.target) && !document.getElementById('value-select-portal')?.contains(e.target)) setOpenPanel(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [openPanel])

  // Listen to context-menu requests from DataTable column headers — opens
  // the relevant toolbar panel (filter/sort/group/fields) and aligns it under
  // the matching toolbar button.
  useEffect(() => {
    function onOpenPanel(e) {
      if (e.detail?.table !== table) return
      const panel = e.detail?.panel
      if (!panel) return
      const btn = toolbarRef.current?.querySelector(`[data-panel-btn="${panel}"]`)
      if (btn) setPanelAnchor(btn)
      setOpenPanel(panel)
    }
    window.addEventListener('datatable:open-panel', onOpenPanel)
    return () => window.removeEventListener('datatable:open-panel', onOpenPanel)
  }, [table])

  const tabCls = (id) =>
    `px-4 py-2.5 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition-colors ${
      activeViewId === id
        ? 'border-brand-600 text-brand-600'
        : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'
    }`

  return (
    <div className="border-b border-slate-200">

      {/* View tabs — reorderable via pointer drag with live preview.
          Affichée aussi avec ≤1 vue quand la gestion des vues est active (admin) :
          le crayon en bout de barre remplace l'ancienne roue dentelée du header. */}
      {(displayViews.length > 1 || (manageViews && isAdmin)) && (
        <div ref={tabsRef} className="flex items-end gap-0 px-2 overflow-x-auto overflow-y-hidden border-b border-slate-200">
          {displayViews.map((v, _idx) => {
            const canDrag = isAdmin && !!onReorderViews
            const isDragging = draggingId === v.id
            return (
              <button
                key={v.id}
                ref={el => { if (el) tabElsRef.current[v.id] = el }}
                className={`${tabCls(v.id)} select-none ${isDragging ? 'opacity-40 scale-95' : ''}`}
                onClick={() => { if (!draggingId) { flushSave(); setActiveViewId(v.id) } }}
                onContextMenu={isAdmin ? (e) => {
                  e.preventDefault()
                  setViewMenu({ x: e.clientX, y: e.clientY, viewId: v.id })
                } : undefined}
                onPointerDown={canDrag ? (e) => {
                  if (e.button !== 0) return
                  setDraggingId(v.id)
                  setDragPreview([...mergedViews])
                  e.currentTarget.setPointerCapture(e.pointerId)
                } : undefined}
                onPointerMove={canDrag ? (e) => {
                  if (!draggingIdRef.current) return
                  const container = tabsRef.current
                  if (!container) return
                  const preview = dragPreviewRef.current || mergedViews
                  const dragIdx = preview.findIndex(x => x.id === draggingIdRef.current)
                  if (dragIdx === -1) return
                  const tabs = [...container.children]
                  let insertIdx = 0
                  let count = 0
                  for (let i = 0; i < tabs.length; i++) {
                    if (i === dragIdx) continue
                    const rect = tabs[i].getBoundingClientRect()
                    if (e.clientX > rect.left + rect.width / 2) insertIdx = count + 1
                    count++
                  }
                  const draggedItem = preview[dragIdx]
                  const without = preview.filter(x => x.id !== draggingIdRef.current)
                  const newPreview = [...without]
                  newPreview.splice(insertIdx, 0, draggedItem)
                  if (newPreview.every((x, i) => x.id === preview[i]?.id)) return
                  captureRects()
                  setDragPreview(newPreview)
                } : undefined}
                onPointerUp={canDrag ? () => {
                  if (!draggingIdRef.current) { setDraggingId(null); setDragPreview(null); return }
                  const preview = dragPreviewRef.current
                  if (preview) {
                    captureRects()
                    onReorderViews(preview)
                  }
                  setDraggingId(null)
                  setDragPreview(null)
                } : undefined}
                style={canDrag ? { cursor: isDragging ? 'grabbing' : 'grab' } : undefined}
              >
                <span className="inline-flex items-center gap-1">
                  {v.locked && <Lock size={11} className="text-amber-600 flex-shrink-0" title="Vue verrouillée (lecture seule)" />}
                  {v.label}
                </span>
              </button>
            )
          })}
          {manageViews && table && isAdmin && (
            <button
              onClick={createViewInline}
              data-testid="view-add-btn"
              className="self-center p-1.5 mx-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded transition-colors flex-shrink-0"
              title="Nouvelle vue"
            >
              <Plus size={16} />
            </button>
          )}
          {manageViews && table && isAdmin && manageViewsBulkDelete && (
            <TableConfigModal table={table} bulkDelete={manageViewsBulkDelete} />
          )}
        </div>
      )}

      {/* Menu contextuel de vue (clic droit sur un onglet, admin only).
          Position fixed → pas clippé par l'overflow-x-auto de la barre. */}
      {viewMenu && (() => {
        const v = views.find(x => x.id === viewMenu.viewId)
        if (!v) return null
        const itemCls = 'flex items-center gap-2 w-full px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 text-left'
        const lastView = views.length <= 1
        return (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setViewMenu(null)} onContextMenu={e => { e.preventDefault(); setViewMenu(null) }} />
            <div
              data-testid="view-context-menu"
              className="fixed z-50 bg-white border border-slate-200 rounded-lg shadow-lg py-1 min-w-[200px]"
              style={{ top: viewMenu.y, left: viewMenu.x }}
            >
              {viewMenu.renaming ? (
                <div className="px-2 py-1 flex items-center gap-1.5">
                  <input
                    autoFocus
                    data-testid="view-rename-input"
                    value={viewMenu.name}
                    onChange={e => setViewMenu(m => ({ ...m, name: e.target.value }))}
                    onKeyDown={e => {
                      if (e.key === 'Enter') renameViewFromMenu()
                      if (e.key === 'Escape') setViewMenu(null)
                    }}
                    className="input text-sm flex-1 min-w-[160px]"
                  />
                  <button onClick={renameViewFromMenu} className="p-1 text-brand-600 hover:text-brand-800" title="Enregistrer">
                    <Check size={15} />
                  </button>
                </div>
              ) : (
                <>
                  {/* Vue verrouillée : renommage et suppression masqués (mêmes
                      règles que la modale « Gérer les vues ») — il faut d'abord
                      déverrouiller. */}
                  {!v.locked && (
                    <button
                      data-testid="view-menu-rename"
                      onClick={() => setViewMenu(m => ({ ...m, renaming: true, name: v.label }))}
                      className={itemCls}
                    >
                      <Pencil size={13} /> Renommer
                    </button>
                  )}
                  <button data-testid="view-menu-lock" onClick={() => toggleViewLockFromMenu(v)} className={itemCls}>
                    {v.locked ? <Unlock size={13} /> : <Lock size={13} />}
                    {v.locked ? 'Déverrouiller' : 'Verrouiller'}
                  </button>
                  {!v.locked && (
                    <>
                      <div className="my-1 border-t border-slate-100" />
                      <button
                        data-testid="view-menu-delete"
                        onClick={() => { if (!lastView) deleteViewFromMenu(v) }}
                        disabled={lastView}
                        title={lastView ? 'Impossible de supprimer la dernière vue' : undefined}
                        className={lastView
                          ? 'flex items-center gap-2 w-full px-3 py-1.5 text-sm text-slate-300 cursor-not-allowed text-left'
                          : 'flex items-center gap-2 w-full px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 text-left'}
                      >
                        <Trash2 size={13} /> Supprimer
                      </button>
                    </>
                  )}
                </>
              )}
            </div>
          </>
        )
      })()}

      {/* Toolbar */}
      <div ref={toolbarRef} className="relative">
        <div className="flex items-center gap-1 px-3 py-2 flex-wrap">

          {searchFields.length > 0 && (
            <div className="relative mr-2">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="input text-xs py-1.5 pl-7 pr-7 w-52"
                placeholder="Rechercher..."
              />
              {search && (
                <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-300 hover:text-slate-500">
                  <X size={12} />
                </button>
              )}
            </div>
          )}

          {visibleCols && setVisibleCols && (
            <ToolbarBtn icon={<Eye size={14} />} label="Champs" active={openPanel === 'fields'}
              dataPanelBtn="fields" disabled={activeViewLocked}
              onClick={(e) => togglePanel('fields', e)} />
          )}

          <ToolbarBtn icon={<Filter size={14} />} label="Filtrer" active={openPanel === 'filter'}
            badge={countFilterRules(filters)}
            dataPanelBtn="filter" disabled={activeViewLocked}
            onClick={(e) => togglePanel('filter', e)} />

          <ToolbarBtn icon={<ArrowUpDown size={14} />} label="Trier" active={openPanel === 'sort'}
            badge={sorts.length}
            dataPanelBtn="sort" disabled={activeViewLocked}
            onClick={(e) => togglePanel('sort', e)} />

          {setGroupBy && (
            <ToolbarBtn
              icon={<Layers size={14} />}
              label="Grouper"
              active={openPanel === 'group' || (Array.isArray(groupBy) ? groupBy.length > 0 : !!groupBy)}
              badge={Array.isArray(groupBy) && groupBy.length > 1 ? groupBy.length : 0}
              dataPanelBtn="group" disabled={activeViewLocked}
              onClick={(e) => togglePanel('group', e)} />
          )}

          {setColorRules && (
            <ToolbarBtn
              icon={<Paintbrush size={14} />}
              label="Couleur"
              active={openPanel === 'color'}
              badge={Array.isArray(colorRules) ? colorRules.length : 0}
              dataPanelBtn="color" disabled={activeViewLocked}
              onClick={(e) => togglePanel('color', e)} />
          )}

          {activeViewLocked && (
            <span
              className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-amber-700 bg-amber-50 rounded"
              title="Vue verrouillée en lecture seule (modifiable par un admin via le menu des vues)"
            >
              <Lock size={12} /> Lecture seule
            </span>
          )}


          <span className="ml-auto text-xs text-slate-400 tabular-nums">
            {processedCount} ligne{processedCount !== 1 ? 's' : ''}
          </span>
        </div>

        {openPanel === 'fields' && visibleCols && setVisibleCols && (
          <FieldsPanel
            columns={columns.filter(c => !disabledColumns?.has(c.field) && !disabledColumns?.has(c.id))}
            visibleCols={visibleCols} onChange={setVisibleCols} anchorEl={panelAnchor}
          />
        )}
        {openPanel === 'filter' && (
          <FilterPanel
            columns={columns.filter(c => c.filterable !== false && !disabledColumns?.has(c.field) && !disabledColumns?.has(c.id))}
            filters={filters} onChange={setFilters} data={data} anchorEl={panelAnchor}
            disabledColumns={disabledColumns}
          />
        )}
        {openPanel === 'sort' && (
          <SortPanel
            columns={columns.filter(c => c.sortable !== false && !disabledColumns?.has(c.field) && !disabledColumns?.has(c.id))}
            sorts={sorts} onChange={setSorts} anchorEl={panelAnchor}
            disabledColumns={disabledColumns}
          />
        )}
        {openPanel === 'color' && setColorRules && (
          <ColorPanel
            columns={columns.filter(c => c.filterable !== false && !disabledColumns?.has(c.field) && !disabledColumns?.has(c.id))}
            rules={colorRules} onChange={setColorRules} data={data} anchorEl={panelAnchor}
            disabledColumns={disabledColumns}
          />
        )}
        {openPanel === 'group' && setGroupBy && (
          <GroupPanel
            columns={columns.filter(c => c.groupable !== false && !disabledColumns?.has(c.field) && !disabledColumns?.has(c.id))}
            groupBy={groupBy}
            onChange={setGroupBy}
            groupOrder={groupOrder}
            setGroupOrder={setGroupOrder}
            onCollapseAll={onCollapseAll} onExpandAll={onExpandAll} anchorEl={panelAnchor}
            disabledColumns={disabledColumns}
          />
        )}
      </div>
    </div>
  )
}
