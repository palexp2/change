import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import { Eye, Filter, ArrowUpDown, Layers, X, Plus, ChevronUp, ChevronDown, Check, Search, ChevronsDownUp, ChevronsUpDown, AlertTriangle } from 'lucide-react'
import { useAuth } from '../lib/auth.jsx'
import { FilterRow, FieldSelect, defaultOpForType } from './FilterRow.jsx'
import api from '../lib/api.js'

function ToolbarBtn({ icon, label, active, badge, onClick }) {
  return (
    <button
      onClick={(e) => onClick(e)}
      className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition-colors ${
        active ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-100'
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

function Panel({ children, className = '', left = 0 }) {
  return (
    <div
      style={{ left }}
      className={`absolute top-full z-50 mt-1 bg-white border border-slate-200 rounded-lg shadow-xl p-4 ${className}`}
    >
      {children}
    </div>
  )
}

function PanelTitle({ children }) {
  return <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">{children}</p>
}

function FieldsPanel({ columns, visibleCols, onChange, left }) {
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
    <Panel className="w-64" left={left}>
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

function FilterPanel({ columns, filters, onChange, data, left, disabledColumns }) {
  const filterableCols = columns.filter(c => c.filterable !== false && c.field)
  const isDisabledField = (fieldName) => !!(disabledColumns && fieldName && disabledColumns.has(fieldName))

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
    <Panel className="w-[540px]" left={left}>
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
        {rules.map((f, i) => {
          const fieldName = f.field_key || f.field
          const broken = isDisabledField(fieldName)
          return (
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
                data={data}
              />
              {broken && (
                <div className="flex items-start gap-1 mt-0.5 ml-1 text-[11px] text-amber-700">
                  <AlertTriangle size={11} className="mt-0.5 flex-shrink-0" />
                  <span>Le champ <code className="font-mono">{fieldName}</code> a été désactivé dans la sync Airtable. Ce filtre ne renverra plus rien — supprime-le ou change le champ.</span>
                </div>
              )}
            </div>
          )
        })}
      </div>
      <button onClick={add} className="mt-3 flex items-center gap-1.5 text-xs text-brand-600 hover:text-brand-800 font-medium">
        <Plus size={13} /> Ajouter un filtre
      </button>
    </Panel>
  )
}

function SortPanel({ columns, sorts, onChange, left, disabledColumns }) {
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
    <Panel className="w-80" left={left}>
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

function GroupPanel({ columns, groupBy, onChange, onCollapseAll, onExpandAll, left, disabledColumns }) {
  const [search, setSearch] = useState('')
  const filtered = search
    ? columns.filter(c => c.label.toLowerCase().includes(search.toLowerCase()))
    : columns
  const groupByBroken = !!(disabledColumns && groupBy && disabledColumns.has(groupBy))

  return (
    <Panel className="w-56" left={left}>
      <PanelTitle>Grouper par</PanelTitle>
      {groupByBroken && (
        <div className="flex items-start gap-1 mb-2 p-1.5 bg-amber-50 border border-amber-200 rounded text-[11px] text-amber-700">
          <AlertTriangle size={11} className="mt-0.5 flex-shrink-0" />
          <span>Le groupage actuel sur <code className="font-mono">{groupBy}</code> pointe sur un champ désactivé dans la sync Airtable.</span>
        </div>
      )}
      {groupBy && (
        <div className="flex items-center gap-1 mb-2">
          <button onClick={onExpandAll} className="flex items-center gap-1 flex-1 justify-center px-2 py-1.5 text-xs text-slate-600 hover:bg-slate-100 rounded border border-slate-200 transition-colors">
            <ChevronsUpDown size={12} /> Tout ouvrir
          </button>
          <button onClick={onCollapseAll} className="flex items-center gap-1 flex-1 justify-center px-2 py-1.5 text-xs text-slate-600 hover:bg-slate-100 rounded border border-slate-200 transition-colors">
            <ChevronsDownUp size={12} /> Tout fermer
          </button>
        </div>
      )}
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
        {!search && (
          <button onClick={() => onChange(null)} className={`flex items-center justify-between w-full px-2 py-1.5 rounded text-sm text-left transition-colors ${!groupBy ? 'bg-brand-50 text-brand-700 font-medium' : 'hover:bg-slate-50 text-slate-600'}`}>
            Aucun {!groupBy && <Check size={13} />}
          </button>
        )}
        {filtered.length === 0
          ? <p className="text-xs text-slate-400 text-center py-2">Aucun résultat</p>
          : filtered.map(col => (
          <button key={col.id} onClick={() => onChange(col.field)} className={`flex items-center justify-between w-full px-2 py-1.5 rounded text-sm text-left transition-colors ${groupBy === col.field ? 'bg-brand-50 text-brand-700 font-medium' : 'hover:bg-slate-50 text-slate-600'}`}>
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
  onCollapseAll, onExpandAll,
  data,
  disabledColumns = null,
}) {
  const [openPanel, setOpenPanel] = useState(null)
  const [panelLeft, setPanelLeft] = useState(0)
  const toolbarRef = useRef(null)

  function togglePanel(name, e) {
    if (openPanel === name) { setOpenPanel(null); return }
    const btn = e?.currentTarget
    if (btn) setPanelLeft(btn.offsetLeft)
    setOpenPanel(name)
  }
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [draggingId, _setDraggingId] = useState(null)
  const draggingIdRef = useRef(null)
  function setDraggingId(v) { draggingIdRef.current = v; _setDraggingId(v) }
  const [dragPreview, _setDragPreview] = useState(null)
  const dragPreviewRef = useRef(null)
  function setDragPreview(v) { dragPreviewRef.current = v; _setDragPreview(v) }
  const tabsRef = useRef(null)
  const tabElsRef = useRef({})
  const flipRectsRef = useRef({})

  // Merged list: real views + virtual "Tous" entry, sorted by their sort_order
  const ALL_ID = '__all__'
  const mergedViews = [
    ...views.map((v, i) => ({ ...v, __sortOrder: v.sort_order ?? i })),
    { id: ALL_ID, label: tableLabel, __sortOrder: allViewSortOrder },
  ].sort((a, b) => a.__sortOrder - b.__sortOrder)

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
    const p = pendingSaveRef.current
    if (!p) return
    pendingSaveRef.current = null
    clearTimeout(autoSaveRef.current)
    api.views.updatePill(p.table, p.viewId, {
      sort: p.sorts,
      filters: p.filters || [],
      visible_columns: p.visibleCols || [],
      group_by: p.groupBy || null,
    }).catch(() => {})
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
      pendingSaveRef.current = { table, viewId: activeViewId, sorts, filters, visibleCols, groupBy }
      clearTimeout(autoSaveRef.current)
      autoSaveRef.current = setTimeout(() => flushSaveRef.current(), 600)
    } else if (visibleCols && visibleCols.length > 0) {
      try { localStorage.setItem(`erp_allView_cols_${table}`, JSON.stringify(visibleCols)) } catch {}
    }
  }, [table, activeViewId, sorts, filters, visibleCols, groupBy])

  useEffect(() => {
    function onBeforeUnload() { flushSaveRef.current() }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      flushSaveRef.current()
    }
  }, [])


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
        ? 'border-brand-600 text-brand-600'
        : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'
    }`

  return (
    <div className="border-b border-slate-200">

      {/* View tabs — reorderable via pointer drag with live preview */}
      {displayViews.length > 1 && (
        <div ref={tabsRef} className="flex items-end gap-0 px-2 overflow-x-auto overflow-y-hidden border-b border-slate-200">
          {displayViews.map((v, _idx) => {
            const realId = v.id === ALL_ID ? null : v.id
            const canDrag = isAdmin && !!onReorderViews
            const isDragging = draggingId === v.id
            return (
              <button
                key={v.id}
                ref={el => { if (el) tabElsRef.current[v.id] = el }}
                className={`${tabCls(realId)} select-none ${isDragging ? 'opacity-40 scale-95' : ''}`}
                onClick={() => { if (!draggingId) { flushSave(); setActiveViewId(realId) } }}
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
                    const newAllPos = preview.findIndex(x => x.id === ALL_ID)
                    const realReordered = preview.filter(x => x.id !== ALL_ID)
                    onReorderViews(realReordered, newAllPos - 0.5)
                  }
                  setDraggingId(null)
                  setDragPreview(null)
                } : undefined}
                style={canDrag ? { cursor: isDragging ? 'grabbing' : 'grab' } : undefined}
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
              onClick={(e) => togglePanel('fields', e)} />
          )}

          <ToolbarBtn icon={<Filter size={14} />} label="Filtrer" active={openPanel === 'filter'}
            badge={Array.isArray(filters) ? filters.length : (filters?.rules?.length || 0)}
            onClick={(e) => togglePanel('filter', e)} />

          <ToolbarBtn icon={<ArrowUpDown size={14} />} label="Trier" active={openPanel === 'sort'}
            badge={sorts.length}
            onClick={(e) => togglePanel('sort', e)} />

          {setGroupBy && (
            <ToolbarBtn icon={<Layers size={14} />} label="Grouper" active={openPanel === 'group' || !!groupBy}
              onClick={(e) => togglePanel('group', e)} />
          )}


          <span className="ml-auto text-xs text-slate-400 tabular-nums">
            {processedCount} ligne{processedCount !== 1 ? 's' : ''}
          </span>
        </div>

        {openPanel === 'fields' && visibleCols && setVisibleCols && (
          <FieldsPanel
            columns={columns.filter(c => !disabledColumns?.has(c.field) && !disabledColumns?.has(c.id))}
            visibleCols={visibleCols} onChange={setVisibleCols} left={panelLeft}
          />
        )}
        {openPanel === 'filter' && (
          <FilterPanel
            columns={columns.filter(c => c.filterable !== false && !disabledColumns?.has(c.field) && !disabledColumns?.has(c.id))}
            filters={filters} onChange={setFilters} data={data} left={panelLeft}
            disabledColumns={disabledColumns}
          />
        )}
        {openPanel === 'sort' && (
          <SortPanel
            columns={columns.filter(c => c.sortable !== false && !disabledColumns?.has(c.field) && !disabledColumns?.has(c.id))}
            sorts={sorts} onChange={setSorts} left={panelLeft}
            disabledColumns={disabledColumns}
          />
        )}
        {openPanel === 'group' && setGroupBy && (
          <GroupPanel
            columns={columns.filter(c => c.groupable !== false && !disabledColumns?.has(c.field) && !disabledColumns?.has(c.id))}
            groupBy={groupBy}
            onChange={v => { setGroupBy(v); setOpenPanel(null) }}
            onCollapseAll={onCollapseAll} onExpandAll={onExpandAll} left={panelLeft}
            disabledColumns={disabledColumns}
          />
        )}
      </div>
    </div>
  )
}
