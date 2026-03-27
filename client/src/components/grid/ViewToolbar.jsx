import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Filter, ArrowUpDown, Layers, Search, Download,
  ChevronDown, Check, Plus, X, MoreHorizontal, Pencil, Copy, Trash2,
  Upload
} from 'lucide-react'
import { baseAPI } from '../../hooks/useBaseAPI.js'
import { FilterBuilder, filterHasRules } from './FilterBuilder.jsx'

// ── Popover wrapper (closes on outside click) ────────────────────────────────

function Popover({ anchor, children, onClose, className = '' }) {
  const ref = useRef()
  useEffect(() => {
    function onClick(e) {
      if (anchor?.current && anchor.current.contains(e.target)) return
      if (ref.current && !ref.current.contains(e.target)) onClose()
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [onClose, anchor])

  return (
    <div
      ref={ref}
      className={`absolute top-full left-0 mt-1 bg-white border border-slate-200 rounded-xl shadow-xl z-30 ${className}`}
    >
      {children}
    </div>
  )
}

// ── ViewSelector ─────────────────────────────────────────────────────────────

function ViewSelector({ tableId, activeViewId, onViewChange, hasUnsaved, onSaveView }) {
  const [views, setViews] = useState([])
  const [open, setOpen] = useState(false)
  const [renamingId, setRenamingId] = useState(null)
  const [renameVal, setRenameVal] = useState('')
  const [menuId, setMenuId] = useState(null)
  const [creating, setCreating] = useState(false)
  const [newViewName, setNewViewName] = useState('')
  const btnRef = useRef()

  const loadViews = useCallback(() => {
    baseAPI.views(tableId).then(res => setViews(res.views || []))
  }, [tableId])

  useEffect(() => { loadViews() }, [loadViews])

  const activeView = views.find(v => v.id === activeViewId)

  async function handleCreate() {
    if (!newViewName.trim()) return
    const res = await baseAPI.createView(tableId, { name: newViewName.trim() })
    setNewViewName('')
    setCreating(false)
    loadViews()
    onViewChange(res.view?.id || res.id, res.view || res)
  }

  async function handleRename(id) {
    await baseAPI.updateView(tableId, id, { name: renameVal.trim() })
    setRenamingId(null)
    loadViews()
  }

  async function handleDuplicate(id) {
    setMenuId(null)
    const res = await baseAPI.duplicateView(tableId, id)
    loadViews()
    onViewChange(res.view?.id || res.id, res.view || res)
  }

  async function handleDelete(id) {
    setMenuId(null)
    setOpen(false)
    await baseAPI.deleteView(tableId, id)
    loadViews()
    // Switch to default view
    const remaining = views.filter(v => v.id !== id)
    const def = remaining.find(v => v.is_default) || remaining[0]
    if (def) onViewChange(def.id, def)
  }

  function handleSelect(view) {
    setOpen(false)
    onViewChange(view.id, view)
  }

  return (
    <div className="relative flex items-center gap-1.5">
      <div ref={btnRef} className="relative">
        <button
          onClick={() => setOpen(s => !s)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-200 text-slate-700 hover:bg-slate-50 transition-colors"
        >
          <span>{activeView?.name || 'Vue'}</span>
          <ChevronDown size={12} />
        </button>

        {open && (
          <Popover anchor={btnRef} onClose={() => setOpen(false)} className="w-56 p-1">
            {views.map(view => (
              <div
                key={view.id}
                className={`group flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer ${
                  view.id === activeViewId ? 'bg-indigo-50 text-indigo-700' : 'hover:bg-slate-50 text-slate-700'
                }`}
                onClick={() => handleSelect(view)}
              >
                {view.id === activeViewId
                  ? <Check size={13} className="shrink-0" />
                  : <span className="w-[13px]" />
                }
                {renamingId === view.id ? (
                  <input
                    autoFocus
                    value={renameVal}
                    onChange={e => setRenameVal(e.target.value)}
                    onClick={e => e.stopPropagation()}
                    onBlur={() => handleRename(view.id)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') handleRename(view.id)
                      if (e.key === 'Escape') setRenamingId(null)
                    }}
                    className="flex-1 text-xs border border-indigo-400 rounded px-1 outline-none"
                  />
                ) : (
                  <span className="text-xs flex-1 truncate">{view.name}</span>
                )}
                {view.is_default && (
                  <span className="text-[10px] px-1 bg-slate-200 text-slate-500 rounded shrink-0">Défaut</span>
                )}
                <button
                  onClick={e => { e.stopPropagation(); setMenuId(menuId === view.id ? null : view.id) }}
                  className="opacity-0 group-hover:opacity-100 p-0.5 text-slate-400 hover:text-slate-600 rounded shrink-0"
                >
                  <MoreHorizontal size={13} />
                </button>
                {menuId === view.id && (
                  <div className="absolute right-1 top-7 bg-white border border-slate-200 rounded-lg shadow-lg z-40 py-1 w-36"
                    onClick={e => e.stopPropagation()}>
                    <button
                      onClick={() => { setRenamingId(view.id); setRenameVal(view.name); setMenuId(null) }}
                      className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
                    >
                      <Pencil size={12} /> Renommer
                    </button>
                    <button
                      onClick={() => handleDuplicate(view.id)}
                      className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
                    >
                      <Copy size={12} /> Dupliquer
                    </button>
                    {!view.is_default && (
                      <button
                        onClick={() => handleDelete(view.id)}
                        className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-red-600 hover:bg-red-50"
                      >
                        <Trash2 size={12} /> Supprimer
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}

            <div className="border-t border-slate-100 mt-1 pt-1">
              {creating ? (
                <div className="px-2 py-1 flex gap-1">
                  <input
                    autoFocus
                    value={newViewName}
                    onChange={e => setNewViewName(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') handleCreate()
                      if (e.key === 'Escape') setCreating(false)
                    }}
                    placeholder="Nom de la vue"
                    className="flex-1 text-xs border border-indigo-400 rounded px-2 py-1 outline-none"
                  />
                  <button onClick={handleCreate} className="text-xs text-indigo-600 font-medium px-1">OK</button>
                </div>
              ) : (
                <button
                  onClick={() => setCreating(true)}
                  className="flex items-center gap-1.5 w-full px-2 py-1.5 text-xs text-slate-500 hover:text-slate-700 hover:bg-slate-50 rounded-lg"
                >
                  <Plus size={12} /> Nouvelle vue
                </button>
              )}
            </div>
          </Popover>
        )}
      </div>

      {hasUnsaved && (
        <button
          onClick={onSaveView}
          className="flex items-center gap-1 px-2 py-1 rounded text-xs text-indigo-600 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 shrink-0" />
          Enregistrer la vue
        </button>
      )}
    </div>
  )
}

// ── FilterButton ─────────────────────────────────────────────────────────────

function FilterButton({ filters, fields, onChange }) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef()

  function countRules(g) {
    if (!g) return 0
    if (Array.isArray(g)) return g.length
    if (!g.rules) return 0
    return g.rules.reduce((n, r) => n + (r.conjunction ? countRules(r) : 1), 0)
  }

  const count = countRules(filters)
  const active = count > 0

  return (
    <div className="relative" ref={btnRef}>
      <button
        onClick={() => setOpen(s => !s)}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
          active ? 'bg-indigo-50 border-indigo-200 text-indigo-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50'
        }`}
      >
        <Filter size={13} />
        Filtres
        {active && (
          <span className="bg-indigo-600 text-white text-xs rounded-full w-4 h-4 flex items-center justify-center font-mono">
            {count}
          </span>
        )}
      </button>

      {open && (
        <Popover anchor={btnRef} onClose={() => setOpen(false)} className="w-[480px] p-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-semibold text-slate-900">Filtres</span>
            {active && (
              <button
                onClick={() => onChange({ conjunction: 'AND', rules: [] })}
                className="text-xs text-red-500 hover:text-red-700"
              >
                Tout effacer
              </button>
            )}
          </div>
          <FilterBuilder filters={filters} fields={fields} onChange={onChange} />
        </Popover>
      )}
    </div>
  )
}

// ── SortButton ───────────────────────────────────────────────────────────────

function SortButton({ sorts, fields, onChange }) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef()
  const active = sorts.length > 0

  function addSort() {
    const usedKeys = new Set(sorts.map(s => s.field_key))
    const field = fields.find(f => !f.deleted_at && !usedKeys.has(f.key))
    if (!field) return
    onChange([...sorts, { field_key: field.key, direction: 'asc' }])
  }

  function updateSort(idx, key, val) {
    onChange(sorts.map((s, i) => i === idx ? { ...s, [key]: val } : s))
  }

  function removeSort(idx) {
    onChange(sorts.filter((_, i) => i !== idx))
  }

  return (
    <div className="relative" ref={btnRef}>
      <button
        onClick={() => setOpen(s => !s)}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
          active ? 'bg-indigo-50 border-indigo-200 text-indigo-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50'
        }`}
      >
        <ArrowUpDown size={13} />
        Tri
        {active && (
          <span className="bg-indigo-600 text-white text-xs rounded-full w-4 h-4 flex items-center justify-center font-mono">
            {sorts.length}
          </span>
        )}
      </button>

      {open && (
        <Popover anchor={btnRef} onClose={() => setOpen(false)} className="w-80 p-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-semibold text-slate-900">Tri</span>
          </div>

          <div className="space-y-2">
            {sorts.map((sort, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <select
                  value={sort.field_key}
                  onChange={e => updateSort(idx, 'field_key', e.target.value)}
                  className="text-sm border border-slate-200 rounded px-2 py-1 flex-1 focus:ring-1 focus:ring-indigo-400 outline-none"
                >
                  {fields.filter(f => !f.deleted_at).map(f => (
                    <option key={f.key} value={f.key}>{f.name}</option>
                  ))}
                </select>
                <select
                  value={sort.direction}
                  onChange={e => updateSort(idx, 'direction', e.target.value)}
                  className="text-sm border border-slate-200 rounded px-2 py-1 w-24 focus:ring-1 focus:ring-indigo-400 outline-none"
                >
                  <option value="asc">A → Z ↑</option>
                  <option value="desc">Z → A ↓</option>
                </select>
                <button onClick={() => removeSort(idx)} className="text-slate-400 hover:text-red-500">
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>

          <button
            onClick={addSort}
            className="mt-3 text-xs text-indigo-600 hover:text-indigo-700 flex items-center gap-1"
          >
            <Plus size={12} /> Ajouter un tri
          </button>
        </Popover>
      )}
    </div>
  )
}

// ── GroupByButton ─────────────────────────────────────────────────────────────

function GroupByButton({ groupBy, groupSummaries, fields, onGroupByChange }) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef()
  const active = groupBy.length > 0

  function addGroup() {
    const usedKeys = new Set(groupBy.map(g => g.field_key))
    const field = fields.find(f => !f.deleted_at && !usedKeys.has(f.key))
    if (!field) return
    onGroupByChange([...groupBy, { field_key: field.key, order: 'asc' }], groupSummaries)
  }

  function updateGroup(idx, key, val) {
    const updated = groupBy.map((g, i) => i === idx ? { ...g, [key]: val } : g)
    onGroupByChange(updated, groupSummaries)
  }

  function removeGroup(idx) {
    const updated = groupBy.filter((_, i) => i !== idx)
    onGroupByChange(updated, groupSummaries)
  }

  function toggleSummaryCount(checked) {
    onGroupByChange(groupBy, { ...groupSummaries, _count: checked })
  }

  function setSummaryField(fieldKey, agg) {
    const updated = { ...groupSummaries }
    if (agg) updated[fieldKey] = agg
    else delete updated[fieldKey]
    onGroupByChange(groupBy, updated)
  }

  const numericFields = fields.filter(f => !f.deleted_at && ['number', 'currency', 'percent'].includes(f.type))

  return (
    <div className="relative" ref={btnRef}>
      <button
        onClick={() => setOpen(s => !s)}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
          active ? 'bg-indigo-50 border-indigo-200 text-indigo-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50'
        }`}
      >
        <Layers size={13} />
        Grouper
        {active && (
          <span className="bg-indigo-600 text-white text-xs rounded-full w-4 h-4 flex items-center justify-center font-mono">
            {groupBy.length}
          </span>
        )}
      </button>

      {open && (
        <Popover anchor={btnRef} onClose={() => setOpen(false)} className="w-80 p-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-semibold text-slate-900">Grouper par</span>
          </div>

          <div className="space-y-2">
            {groupBy.map((g, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <select
                  value={g.field_key}
                  onChange={e => updateGroup(idx, 'field_key', e.target.value)}
                  className="text-sm border border-slate-200 rounded px-2 py-1 flex-1 focus:ring-1 focus:ring-indigo-400 outline-none"
                >
                  {fields.filter(f => !f.deleted_at).map(f => (
                    <option key={f.key} value={f.key}>{f.name}</option>
                  ))}
                </select>
                <select
                  value={g.order}
                  onChange={e => updateGroup(idx, 'order', e.target.value)}
                  className="text-sm border border-slate-200 rounded px-2 py-1 w-20 focus:ring-1 focus:ring-indigo-400 outline-none"
                >
                  <option value="asc">A → Z</option>
                  <option value="desc">Z → A</option>
                </select>
                <button onClick={() => removeGroup(idx)} className="text-slate-400 hover:text-red-500">
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>

          {groupBy.length < 3 && (
            <button
              onClick={addGroup}
              className="mt-2 text-xs text-indigo-600 hover:text-indigo-700 flex items-center gap-1"
            >
              <Plus size={12} /> Ajouter un sous-groupe
            </button>
          )}

          {active && (
            <details className="mt-4">
              <summary className="text-xs text-slate-500 cursor-pointer hover:text-slate-700">Résumés</summary>
              <div className="mt-2 space-y-2 pl-2">
                <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!!groupSummaries?._count}
                    onChange={e => toggleSummaryCount(e.target.checked)}
                    className="w-3.5 h-3.5 rounded border-slate-300 text-indigo-600"
                  />
                  Afficher le nombre
                </label>
                {numericFields.map(f => (
                  <div key={f.key} className="flex items-center gap-2">
                    <span className="text-xs text-slate-600 w-24 truncate">{f.name}</span>
                    <select
                      value={groupSummaries?.[f.key] || ''}
                      onChange={e => setSummaryField(f.key, e.target.value)}
                      className="text-xs border border-slate-200 rounded px-1 py-0.5 flex-1 focus:ring-1 focus:ring-indigo-400 outline-none"
                    >
                      <option value="">Aucun</option>
                      <option value="SUM">Somme</option>
                      <option value="AVG">Moyenne</option>
                      <option value="MIN">Min</option>
                      <option value="MAX">Max</option>
                    </select>
                  </div>
                ))}
              </div>
            </details>
          )}
        </Popover>
      )}
    </div>
  )
}

// ── ExportDropdown ────────────────────────────────────────────────────────────

function ExportDropdown({ tableId, viewId }) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef()

  function doExport(format) {
    setOpen(false)
    const url = baseAPI.exportUrl(tableId, format, viewId ? { view_id: viewId } : {})
    window.location.href = url
  }

  return (
    <div className="relative" ref={btnRef}>
      <button
        onClick={() => setOpen(s => !s)}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors"
      >
        <Download size={13} />
        Exporter
      </button>

      {open && (
        <Popover anchor={btnRef} onClose={() => setOpen(false)} className="w-32 py-1">
          {['csv', 'xlsx', 'json'].map(fmt => (
            <button
              key={fmt}
              onClick={() => doExport(fmt)}
              className="block w-full text-left px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 uppercase"
            >
              {fmt}
            </button>
          ))}
        </Popover>
      )}
    </div>
  )
}

// ── ViewToolbar (export) ─────────────────────────────────────────────────────

export function ViewToolbar({
  tableId,
  fields = [],
  activeViewId,
  filters,
  sorts = [],
  groupBy = [],
  groupSummaries = {},
  search = '',
  onViewChange,
  onFiltersChange,
  onSortsChange,
  onGroupByChange,
  onSearchChange,
  onImportClick,
  initialViewFilters,
  initialViewSorts,
}) {
  // Track unsaved changes vs. saved view state
  const savedStateRef = useRef({ filters: null, sorts: null })
  const [hasUnsaved, setHasUnsaved] = useState(false)

  useEffect(() => {
    // When view changes, reset unsaved tracking
    savedStateRef.current = {
      filters: JSON.stringify(filters),
      sorts: JSON.stringify(sorts),
    }
    setHasUnsaved(false)
  }, [activeViewId])

  useEffect(() => {
    if (!activeViewId) return
    const currentFilters = JSON.stringify(filters)
    const currentSorts = JSON.stringify(sorts)
    const changed =
      currentFilters !== savedStateRef.current.filters ||
      currentSorts !== savedStateRef.current.sorts
    setHasUnsaved(changed)
  }, [filters, sorts, activeViewId])

  async function handleSaveView() {
    if (!activeViewId) return
    await baseAPI.updateView(tableId, activeViewId, {
      filters: JSON.stringify(filters),
      sorts: JSON.stringify(sorts),
      group_by: JSON.stringify(groupBy),
      group_summaries: JSON.stringify(groupSummaries),
    })
    savedStateRef.current = {
      filters: JSON.stringify(filters),
      sorts: JSON.stringify(sorts),
    }
    setHasUnsaved(false)
  }

  return (
    <div className="flex items-center gap-2 px-4 py-2 border-b border-slate-200 bg-white flex-wrap shrink-0">
      <ViewSelector
        tableId={tableId}
        activeViewId={activeViewId}
        onViewChange={onViewChange}
        hasUnsaved={hasUnsaved}
        onSaveView={handleSaveView}
      />

      <div className="w-px h-5 bg-slate-200 shrink-0" />

      <FilterButton
        filters={filters}
        fields={fields}
        onChange={onFiltersChange}
      />

      <SortButton
        sorts={sorts}
        fields={fields}
        onChange={onSortsChange}
      />

      <GroupByButton
        groupBy={groupBy}
        groupSummaries={groupSummaries}
        fields={fields}
        onGroupByChange={onGroupByChange}
      />

      <div className="ml-auto flex items-center gap-2">
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          <input
            type="text"
            placeholder="Rechercher…"
            value={search}
            onChange={e => onSearchChange(e.target.value)}
            className="pl-8 pr-3 py-1.5 text-sm border border-slate-200 rounded-lg w-44 focus:w-56 transition-all focus:ring-2 focus:ring-indigo-400 focus:border-transparent outline-none"
          />
        </div>

        {onImportClick && (
          <button onClick={onImportClick}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors">
            <Upload size={13} />
            Importer
          </button>
        )}
        <ExportDropdown tableId={tableId} viewId={activeViewId} />
      </div>
    </div>
  )
}
