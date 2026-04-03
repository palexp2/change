import { useState, useRef, useEffect } from 'react'
import { Eye, Filter, ArrowUpDown, Layers, X, Plus, ChevronUp, ChevronDown, Check, Search, Save } from 'lucide-react'
import { useAuth } from '../lib/auth.jsx'
import { FilterRow, defaultOpForType, getFieldType } from './FilterRow.jsx'
import api from '../lib/api.js'

function ToolbarBtn({ icon, label, active, badge, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition-colors ${
        active ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-100'
      }`}
    >
      {icon}
      {label}
      {badge > 0 && (
        <span className="bg-indigo-600 text-white rounded-full w-4 h-4 flex items-center justify-center text-[10px] leading-none">
          {badge}
        </span>
      )}
    </button>
  )
}

function Panel({ children, className = '' }) {
  return (
    <div className={`absolute top-full left-0 z-50 mt-1 bg-white border border-slate-200 rounded-lg shadow-xl p-4 ${className}`}>
      {children}
    </div>
  )
}

function PanelTitle({ children }) {
  return <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">{children}</p>
}

function FieldsPanel({ columns, visibleCols, onChange }) {
  const [search, setSearch] = useState('')
  const filtered = search
    ? columns.filter(c => c.label.toLowerCase().includes(search.toLowerCase()))
    : columns

  return (
    <Panel className="w-64">
      <PanelTitle>Colonnes visibles</PanelTitle>
      <div className="relative mb-2">
        <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full pl-7 pr-2 py-1.5 text-xs border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-indigo-400"
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
              className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
            />
            <span className="text-sm text-slate-700">{col.label}</span>
          </label>
        ))}
      </div>
    </Panel>
  )
}

function FilterPanel({ columns, filters, onChange }) {
  const filterableCols = columns.filter(c => c.filterable !== false && c.field)

  // Normalize to {conjunction, rules} format
  const normalized = Array.isArray(filters)
    ? { conjunction: 'AND', rules: filters }
    : (filters?.rules ? filters : { conjunction: 'AND', rules: [] })
  const { conjunction, rules } = normalized

  function add() {
    const first = filterableCols[0]
    const type = first?.type || 'text'
    onChange({ ...normalized, rules: [...rules, { field: first?.field ?? '', op: defaultOpForType(type), value: '' }] })
  }
  function update(i, newFilter) {
    onChange({ ...normalized, rules: rules.map((item, idx) => idx === i ? newFilter : item) })
  }
  function remove(i) {
    onChange({ ...normalized, rules: rules.filter((_, idx) => idx !== i) })
  }

  return (
    <Panel className="w-[540px]">
      <div className="flex items-center justify-between mb-3">
        <PanelTitle className="mb-0">Filtres</PanelTitle>
        {rules.length > 1 && (
          <div className="flex items-center gap-0.5 bg-slate-100 rounded p-0.5">
            <button onClick={() => onChange({ ...normalized, conjunction: 'AND' })}
              className={`text-xs px-2.5 py-1 rounded transition-colors font-medium ${conjunction === 'AND' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
              ET
            </button>
            <button onClick={() => onChange({ ...normalized, conjunction: 'OR' })}
              className={`text-xs px-2.5 py-1 rounded transition-colors font-medium ${conjunction === 'OR' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
              OU
            </button>
          </div>
        )}
      </div>
      <div className="space-y-1 max-h-64 overflow-y-auto">
        {rules.length === 0 && (
          <p className="text-sm text-slate-400 py-1">Aucun filtre actif</p>
        )}
        {rules.map((f, i) => (
          <div key={i}>
            {i > 0 && (
              <div className="flex items-center gap-2 my-1.5">
                <div className="flex-1 h-px bg-slate-100" />
                <span className="text-[10px] font-bold text-slate-400 tracking-wide">{conjunction === 'OR' ? 'OU' : 'ET'}</span>
                <div className="flex-1 h-px bg-slate-100" />
              </div>
            )}
            <FilterRow
              columns={columns}
              filter={f}
              onChange={updated => update(i, updated)}
              onRemove={() => remove(i)}
              size="xs"
            />
          </div>
        ))}
      </div>
      <button onClick={add} className="mt-3 flex items-center gap-1.5 text-xs text-indigo-600 hover:text-indigo-800 font-medium">
        <Plus size={13} /> Ajouter un filtre
      </button>
    </Panel>
  )
}

function SortPanel({ columns, sorts, onChange }) {
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
    <Panel className="w-80">
      <PanelTitle>Trier par</PanelTitle>
      <div className="space-y-2 max-h-60 overflow-y-auto">
        {sorts.length === 0 && <p className="text-sm text-slate-400 py-1">Aucun tri actif</p>}
        {sorts.map((s, i) => (
          <div key={i} className="flex items-center gap-2">
            <select value={s.field} onChange={e => update(i, { field: e.target.value })} className="select text-xs py-1.5 flex-1">
              {columns.map(c => <option key={c.id} value={c.field}>{c.label}</option>)}
            </select>
            <button onClick={() => update(i, { dir: s.dir === 'asc' ? 'desc' : 'asc' })} className="flex items-center gap-1 px-2.5 py-1.5 text-xs border border-slate-200 rounded hover:bg-slate-50 flex-shrink-0 text-slate-600">
              {s.dir === 'asc' ? <><ChevronUp size={12} /> Croissant</> : <><ChevronDown size={12} /> Décroissant</>}
            </button>
            <button onClick={() => remove(i)} className="text-slate-300 hover:text-red-500 flex-shrink-0"><X size={14} /></button>
          </div>
        ))}
      </div>
      <button onClick={add} className="mt-3 flex items-center gap-1.5 text-xs text-indigo-600 hover:text-indigo-800 font-medium">
        <Plus size={13} /> Ajouter un tri
      </button>
    </Panel>
  )
}

function GroupPanel({ columns, groupBy, onChange }) {
  return (
    <Panel className="w-56">
      <PanelTitle>Grouper par</PanelTitle>
      <div className="space-y-0.5 max-h-60 overflow-y-auto">
        <button onClick={() => onChange(null)} className={`flex items-center justify-between w-full px-2 py-1.5 rounded text-sm text-left transition-colors ${!groupBy ? 'bg-indigo-50 text-indigo-700 font-medium' : 'hover:bg-slate-50 text-slate-600'}`}>
          Aucun {!groupBy && <Check size={13} />}
        </button>
        {columns.map(col => (
          <button key={col.id} onClick={() => onChange(col.field)} className={`flex items-center justify-between w-full px-2 py-1.5 rounded text-sm text-left transition-colors ${groupBy === col.field ? 'bg-indigo-50 text-indigo-700 font-medium' : 'hover:bg-slate-50 text-slate-600'}`}>
            {col.label} {groupBy === col.field && <Check size={13} />}
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
  allViewSortOrder = -1,
  onReorderViews,
  activeViewId,
  setActiveViewId,
  tableLabel,
  processedCount,
  visibleCols, setVisibleCols,
  groupBy, setGroupBy,
}) {
  const [openPanel, setOpenPanel] = useState(null)
  const toolbarRef = useRef(null)
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [draggingId, setDraggingId] = useState(null)
  const [dragOverId, setDragOverId] = useState(null)

  // Merged list: real views + virtual "Tous" entry, sorted by their sort_order
  const ALL_ID = '__all__'
  const mergedViews = [
    ...views.map((v, i) => ({ ...v, __sortOrder: v.sort_order ?? i })),
    { id: ALL_ID, label: tableLabel, __sortOrder: allViewSortOrder },
  ].sort((a, b) => a.__sortOrder - b.__sortOrder)
  const [saving, setSaving] = useState(false)

  async function handleSaveView() {
    if (!table || !activeViewId) return
    setSaving(true)
    try {
      await api.views.updatePill(table, activeViewId, {
        sort: sorts,
        filters: Array.isArray(filters) ? filters : [],
        visible_columns: visibleCols || [],
        group_by: groupBy || null,
      })
      window.dispatchEvent(new CustomEvent('views:updated', { detail: { table } }))
    } catch (e) {
      alert(e.message)
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => {
    if (!openPanel) return
    function handler(e) {
      if (toolbarRef.current && !toolbarRef.current.contains(e.target) && !document.getElementById('field-select-portal')?.contains(e.target)) setOpenPanel(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [openPanel])

  const tabCls = (id) =>
    `px-4 py-2.5 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition-colors ${
      activeViewId === id
        ? 'border-indigo-600 text-indigo-600'
        : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'
    }`

  return (
    <div className="border-b border-slate-200">

      {/* View tabs — "Tous" est draggable comme les autres */}
      {mergedViews.length > 1 && (
        <div className="flex items-end gap-0 px-2 overflow-x-auto border-b border-slate-200">
          {mergedViews.map(v => {
            const realId = v.id === ALL_ID ? null : v.id
            const isAll = v.id === ALL_ID
            return (
              <button
                key={v.id}
                className={`${tabCls(realId)} ${draggingId === v.id ? 'opacity-40' : ''} ${dragOverId === v.id && dragOverId !== draggingId ? 'border-b-2 border-indigo-300' : ''}`}
                onClick={() => setActiveViewId(realId)}
                draggable={isAdmin && !!onReorderViews}
                onDragStart={isAdmin && onReorderViews ? (e) => {
                  setDraggingId(v.id)
                  e.dataTransfer.effectAllowed = 'move'
                } : undefined}
                onDragOver={isAdmin && onReorderViews ? (e) => {
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  setDragOverId(v.id)
                } : undefined}
                onDrop={isAdmin && onReorderViews ? (e) => {
                  e.preventDefault()
                  if (!draggingId || draggingId === v.id) return
                  const from = mergedViews.findIndex(x => x.id === draggingId)
                  const to = mergedViews.findIndex(x => x.id === v.id)
                  const reordered = [...mergedViews]
                  const [item] = reordered.splice(from, 1)
                  reordered.splice(to, 0, item)
                  // Recalculate sort_order for each entry
                  const newAllPos = reordered.findIndex(x => x.id === ALL_ID)
                  const realReordered = reordered.filter(x => x.id !== ALL_ID)
                  onReorderViews(realReordered, newAllPos)
                  setDraggingId(null)
                  setDragOverId(null)
                } : undefined}
                onDragEnd={() => { setDraggingId(null); setDragOverId(null) }}
                style={isAdmin && onReorderViews ? { cursor: 'grab' } : undefined}
              >
                {v.label}
              </button>
            )
          })}
        </div>
      )}

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
              onClick={() => setOpenPanel(p => p === 'fields' ? null : 'fields')} />
          )}

          <ToolbarBtn icon={<Filter size={14} />} label="Filtrer" active={openPanel === 'filter'}
            badge={Array.isArray(filters) ? filters.length : (filters?.rules?.length || 0)}
            onClick={() => setOpenPanel(p => p === 'filter' ? null : 'filter')} />

          <ToolbarBtn icon={<ArrowUpDown size={14} />} label="Trier" active={openPanel === 'sort'}
            badge={sorts.length}
            onClick={() => setOpenPanel(p => p === 'sort' ? null : 'sort')} />

          {setGroupBy && (
            <ToolbarBtn icon={<Layers size={14} />} label="Grouper" active={openPanel === 'group' || !!groupBy}
              onClick={() => setOpenPanel(p => p === 'group' ? null : 'group')} />
          )}

          {isAdmin && activeViewId !== null && table && (
            <button
              onClick={handleSaveView}
              disabled={saving}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium text-indigo-600 hover:bg-indigo-50 transition-colors disabled:opacity-50"
              title="Enregistrer les filtres, tris et colonnes dans cette vue"
            >
              <Save size={13} />
              {saving ? 'Enregistrement...' : 'Sauvegarder la vue'}
            </button>
          )}

          <span className="ml-auto text-xs text-slate-400 tabular-nums">
            {processedCount} ligne{processedCount !== 1 ? 's' : ''}
          </span>
        </div>

        {openPanel === 'fields' && visibleCols && setVisibleCols && (
          <FieldsPanel columns={columns} visibleCols={visibleCols} onChange={setVisibleCols} />
        )}
        {openPanel === 'filter' && (
          <FilterPanel columns={columns.filter(c => c.filterable !== false)} filters={filters} onChange={setFilters} />
        )}
        {openPanel === 'sort' && (
          <SortPanel columns={columns.filter(c => c.sortable !== false)} sorts={sorts} onChange={setSorts} />
        )}
        {openPanel === 'group' && setGroupBy && (
          <GroupPanel columns={columns.filter(c => c.groupable !== false)} groupBy={groupBy}
            onChange={v => { setGroupBy(v); setOpenPanel(null) }} />
        )}
      </div>
    </div>
  )
}
