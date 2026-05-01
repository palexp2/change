import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronRight, ChevronDown, Trash2, Plus, Edit2 } from 'lucide-react'
import { useTableView } from '../lib/useTableView.js'
import { ViewToolbar } from './ViewToolbar.jsx'
import { TABLE_ALL_LABEL } from '../lib/tableDefs.js'
import api from '../lib/api.js'
import { fmtDate } from '../lib/formatDate.js'
import { useConfirm } from './ConfirmProvider.jsx'
import { useToast } from '../contexts/ToastContext.jsx'

export function fmtPhone(val) {
  if (!val) return ''
  const digits = String(val).replace(/\D/g, '')
  const d = digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
  return val
}

function DynamicCell({ value, col }) {
  if (value === null || value === undefined || value === '') return <span className="text-slate-300">—</span>
  const type = col.type

  if (type === 'single_select') {
    return <span className="inline-block text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-700">{value}</span>
  }
  if (type === 'multi_select') {
    let items = value
    try { items = JSON.parse(value) } catch {}
    if (!Array.isArray(items)) items = [items]
    return (
      <div className="flex gap-1 flex-wrap">
        {items.map((v, i) => <span key={i} className="text-xs px-2 py-0.5 rounded-full bg-brand-50 text-brand-700">{v}</span>)}
      </div>
    )
  }
  if (type === 'checkbox') {
    return <span>{value === 1 || value === true || value === '1' ? '✓' : '—'}</span>
  }
  if (type === 'date') {
    let formatted
    try { formatted = fmtDate(value) } catch { formatted = null }
    return formatted
      ? <span className="text-slate-500 text-sm">{formatted}</span>
      : <span>{value}</span>
  }
  if (type === 'number') {
    return <span className="tabular-nums">{value}</span>
  }
  if (type === 'phone') {
    return <span className="font-mono text-sm">{fmtPhone(value)}</span>
  }
  // Image URL — render as thumbnail
  if (type === 'text' && col.options?.format === 'url') {
    const str = String(value)
    if (/\.(jpe?g|png|gif|webp|svg|avif)(\?.*)?$/i.test(str) || str.includes('/product-images/')) {
      return <img src={str} alt="" className="h-8 w-8 object-cover rounded" loading="lazy" />
    }
  }
  // text, long_text, link, etc.
  const str = String(value)
  return <span className="truncate">{str.length > 100 ? str.slice(0, 100) + '…' : str}</span>
}

function ResizeHandle({ onResize }) {
  const startX = useRef(0)
  const startW = useRef(0)

  function onPointerDown(e) {
    e.preventDefault()
    e.stopPropagation()
    startX.current = e.clientX
    startW.current = e.currentTarget.parentElement.offsetWidth
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  function onPointerMove(e) {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    const delta = e.clientX - startX.current
    const newW = Math.max(50, startW.current + delta)
    onResize(newW)
  }

  function onPointerUp(e) {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  return (
    <div
      className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize z-10 bg-transparent group-hover/header:bg-slate-200 hover:!bg-brand-400 active:!bg-brand-500"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  )
}

export function DataTable({
  table,
  columns,
  data,
  loading,
  onRowClick,
  searchFields = [],
  height = 'calc(100vh - 260px)',
  initialGroupBy = null,
  forceAllView = false,
  onBulkDelete,
  disabledColumns = null, // Map<column_name, { airtable_field_name }> | null
  onAddCustomField,       // () => void — affiche le bouton "+" en bout de header
  customFieldsByColumn,   // Map<column_name, { id, name, type, decimals }> — pour right-click menu
  onEditCustomField,      // (field) => void
  onDeleteCustomField,    // (field) => void
}) {
  const [visibleCols, setVisibleCols] = useState([])
  const [groupBy, setGroupBy] = useState(initialGroupBy)
  const [collapsedGroups, setCollapsedGroups] = useState(new Set())
  const [colWidths, setColWidths] = useState({})
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [deleting, setDeleting] = useState(false)
  const [colMenu, setColMenu] = useState(null) // { x, y, field } pour right-click menu
  // Tracks previously seen custom-field column ids so we can auto-show newly
  // created fields in the active view (the user vient de créer le champ, on
  // suppose qu'ils veulent le voir tout de suite).
  const prevCustomFieldKeys = useRef(null)
  const confirm = useConfirm()
  const { addToast } = useToast()

  const view = useTableView({ table, columns, data, searchFields, forceAllView })
  const { filteredData, configReady, allColumns, bulkDeleteEnabled } = view
  const selectionActive = bulkDeleteEnabled && typeof onBulkDelete === 'function'
  // Use allColumns (hardcoded + dynamic Airtable fields) everywhere
  const mergedColumns = allColumns || columns
  // Helper passé aux consumers pour savoir si une colonne est désactivée
  // (import Airtable coupé via la modale de sync). Comparaison sur field OU id.
  const isDisabled = useCallback((c) => {
    if (!disabledColumns || disabledColumns.size === 0 || !c) return false
    return disabledColumns.has(c.field) || disabledColumns.has(c.id)
  }, [disabledColumns])

  const parentRef = useRef(null)
  const saveWidthsTimer = useRef(null)

  // Load persisted column widths from config
  useEffect(() => {
    if (!view.configReady) return
    if (view.columnWidths && Object.keys(view.columnWidths).length > 0) {
      setColWidths(view.columnWidths)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.configReady])

  function handleColResize(colId, width) {
    setColWidths(prev => {
      const next = { ...prev, [colId]: width }
      clearTimeout(saveWidthsTimer.current)
      saveWidthsTimer.current = setTimeout(() => {
        api.views.saveColumnWidths(table, next).catch(() => {})
      }, 500)
      return next
    })
  }

  // Apply view config when active view changes
  useEffect(() => {
    if (!view.configReady) return
    setVisibleCols(view.viewVisibleColumns)
    if (!forceAllView) {
      const newGroupBy = view.viewGroupBy
      setGroupBy(newGroupBy)
      prevGroupByRef.current = newGroupBy
      // Restore collapsed groups from localStorage
      try {
        const key = `erp_collapsed_${table}_${view.activeViewId || '__all__'}`
        const stored = JSON.parse(localStorage.getItem(key) || '[]')
        setCollapsedGroups(new Set(stored))
      } catch { setCollapsedGroups(new Set()) }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.activeViewId, view.configReady])

  // Auto-show newly created custom fields in the active view : on diffe les
  // clés de customFieldsByColumn entre renders ; toute nouvelle clé est
  // ajoutée à visibleCols (l'autosave de ViewToolbar persiste). Skippé au
  // premier render pour ne pas clobber la liste initiale chargée du serveur.
  useEffect(() => {
    if (!view.configReady) return
    if (!customFieldsByColumn) return
    const currentKeys = new Set(customFieldsByColumn.keys())
    const prev = prevCustomFieldKeys.current
    if (prev) {
      const newOnes = [...currentKeys].filter(k => !prev.has(k))
      if (newOnes.length > 0) {
        setVisibleCols(cols => {
          const set = new Set(cols)
          for (const k of newOnes) set.add(k)
          return [...set]
        })
      }
    }
    prevCustomFieldKeys.current = currentKeys
  }, [customFieldsByColumn, view.configReady])

  const visibleColumns = useMemo(
    () => visibleCols
      .map(id => mergedColumns.find(c => c.id === id))
      .filter(Boolean)
      .filter(c => !isDisabled(c)), // colonnes dont l'import Airtable est désactivé : on les retire du rendu
    [mergedColumns, visibleCols, isDisabled]
  )

  const [dragOverCol, setDragOverCol] = useState(null)
  const [dragOverSide, setDragOverSide] = useState(null) // 'before' | 'after'
  const dragColRef = useRef(null)

  function handleColDragStart(e, colId) {
    dragColRef.current = colId
    e.dataTransfer.effectAllowed = 'move'
    try { e.dataTransfer.setData('text/plain', colId) } catch {}
  }
  function handleColDragOver(e, colId) {
    if (!dragColRef.current) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const rect = e.currentTarget.getBoundingClientRect()
    const side = (e.clientX - rect.left) < rect.width / 2 ? 'before' : 'after'
    if (dragOverCol !== colId) setDragOverCol(colId)
    if (dragOverSide !== side) setDragOverSide(side)
  }
  function handleColDrop(e) {
    e.preventDefault()
    const sourceId = dragColRef.current
    const targetId = dragOverCol
    const side = dragOverSide
    dragColRef.current = null
    setDragOverCol(null)
    setDragOverSide(null)
    if (!sourceId || !targetId || sourceId === targetId) return
    const next = visibleCols.filter(id => id !== sourceId)
    let idx = next.indexOf(targetId)
    if (idx === -1) return
    if (side === 'after') idx += 1
    next.splice(idx, 0, sourceId)
    setVisibleCols(next)
  }
  function handleColDragEnd() {
    dragColRef.current = null
    setDragOverCol(null)
    setDragOverSide(null)
  }

  const gridTemplate = useMemo(() => {
    const cols = visibleColumns.map(c => colWidths[c.id] ? `${colWidths[c.id]}px` : 'minmax(120px, 1fr)').join(' ')
    // Si on a un onAddCustomField, on réserve une colonne `auto` à la fin pour
    // le bouton "+" — les rows de données auront simplement une cellule vide.
    const withAdd = onAddCustomField ? `${cols} 36px` : cols
    return selectionActive ? `40px ${withAdd}` : withAdd
  }, [visibleColumns, colWidths, selectionActive, onAddCustomField])

  // Reset selection when data changes (e.g., after delete, filter)
  const visibleIds = useMemo(() => filteredData.map(r => r.id).filter(Boolean), [filteredData])
  const allVisibleSelected = selectionActive && visibleIds.length > 0 && visibleIds.every(id => selectedIds.has(id))
  const someVisibleSelected = selectionActive && !allVisibleSelected && visibleIds.some(id => selectedIds.has(id))

  useEffect(() => {
    // Purge stale IDs when data shrinks (after delete or filter)
    if (!selectionActive) return
    setSelectedIds(prev => {
      if (prev.size === 0) return prev
      const dataIds = new Set(data.map(r => r.id))
      const next = new Set([...prev].filter(id => dataIds.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [data, selectionActive])

  function toggleRow(id) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function toggleAllVisible() {
    setSelectedIds(prev => {
      if (allVisibleSelected) {
        const next = new Set(prev)
        for (const id of visibleIds) next.delete(id)
        return next
      }
      const next = new Set(prev)
      for (const id of visibleIds) next.add(id)
      return next
    })
  }

  async function handleBulkDelete() {
    const ids = [...selectedIds]
    if (!ids.length) return
    if (!(await confirm(`Supprimer ${ids.length} enregistrement${ids.length > 1 ? 's' : ''} ? Cette action est irréversible.`))) return
    setDeleting(true)
    try {
      await onBulkDelete(ids)
      setSelectedIds(new Set())
    } catch (err) {
      addToast({ message: 'Erreur lors de la suppression : ' + (err?.message || 'inconnue'), type: 'error' })
    } finally {
      setDeleting(false)
    }
  }

  const collapsedStorageKey = `erp_collapsed_${table}_${view.activeViewId || '__all__'}`
  const storageKeyRef = useRef(collapsedStorageKey)
  storageKeyRef.current = collapsedStorageKey

  function saveCollapsed(set) {
    try { localStorage.setItem(storageKeyRef.current, JSON.stringify([...set])) } catch {}
  }

  const toggleGroup = useCallback(key => {
    setCollapsedGroups(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      saveCollapsed(next)
      return next
    })
  }, [])

  const prevGroupByRef = useRef(groupBy)
  useEffect(() => {
    if (prevGroupByRef.current !== groupBy) {
      setCollapsedGroups(new Set())
      prevGroupByRef.current = groupBy
    }
  }, [groupBy])

  const numberColumns = useMemo(
    () => mergedColumns.filter(c => c.type === 'number' || c.type === 'currency'),
    [mergedColumns]
  )

  const virtualItems = useMemo(() => {
    if (!groupBy) return filteredData
    const groups = new Map()
    for (const row of filteredData) {
      const key = String(row[groupBy] ?? '(vide)')
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(row)
    }
    const flat = []
    for (const [key, rows] of groups) {
      const collapsed = collapsedGroups.has(key)
      const sums = {}
      if (numberColumns.length > 0) {
        for (const col of numberColumns) {
          let total = 0
          for (const row of rows) {
            const v = parseFloat(row[col.field])
            if (!isNaN(v)) total += v
          }
          if (total !== 0) sums[col.field] = total
        }
      }
      flat.push({ __isGroup: true, __key: key, __count: rows.length, __collapsed: collapsed, __sums: sums })
      if (!collapsed) flat.push(...rows)
    }
    return flat
  }, [filteredData, groupBy, collapsedGroups, numberColumns])

  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: virtualItems.length,
    getScrollElement: () => parentRef.current,
    estimateSize: i => virtualItems[i]?.__isGroup ? 34 : 48,
    overscan: 12,
  })

  const groupKeys = useMemo(
    () => virtualItems.filter(i => i.__isGroup).map(i => i.__key),
    [virtualItems]
  )

  const collapseAll = useCallback(() => {
    const s = new Set(groupKeys)
    setCollapsedGroups(s)
    saveCollapsed(s)
  }, [groupKeys])
  const expandAll = useCallback(() => {
    const s = new Set()
    setCollapsedGroups(s)
    saveCollapsed(s)
  }, [])

  if (!configReady) return null

  return (
    <div className="card overflow-hidden flex flex-col">

      <ViewToolbar
        table={table}
        columns={mergedColumns}
        sorts={view.sorts} setSorts={view.setSorts}
        filters={view.filters} setFilters={view.setFilters}
        search={view.search} setSearch={view.setSearch}
        searchFields={searchFields}
        views={view.views}
        allViewSortOrder={view.allViewSortOrder}
        onReorderViews={view.reorderViews}
        activeViewId={view.activeViewId}
        setActiveViewId={view.setActiveViewId}
        tableLabel={TABLE_ALL_LABEL[table] || 'Tous'}
        processedCount={filteredData.length}
        visibleCols={visibleCols} setVisibleCols={setVisibleCols}
        groupBy={groupBy} setGroupBy={setGroupBy}
        onCollapseAll={collapseAll} onExpandAll={expandAll}
        data={data}
        disabledColumns={disabledColumns}
      />

      {selectionActive && selectedIds.size > 0 && (
        <div className="flex items-center justify-between gap-3 px-4 py-2 bg-brand-50 border-b border-brand-100">
          <span className="text-sm text-brand-900">
            {selectedIds.size} sélectionné{selectedIds.size > 1 ? 's' : ''}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSelectedIds(new Set())}
              className="text-xs text-slate-500 hover:text-slate-700 px-2 py-1"
            >
              Désélectionner
            </button>
            <button
              onClick={handleBulkDelete}
              disabled={deleting}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 px-3 py-1.5 rounded transition-colors"
            >
              <Trash2 size={13} />
              {deleting ? 'Suppression...' : 'Supprimer'}
            </button>
          </div>
        </div>
      )}

      <div ref={parentRef} className="overflow-auto" style={{ height }}>
        <div style={{ minWidth: 'max-content' }}>
          <div
            className="group/header grid border-b border-slate-200 bg-slate-50 sticky top-0 z-10"
            style={{ gridTemplateColumns: gridTemplate }}
          >
            {selectionActive && (
              <div className="flex items-center justify-center px-2">
                <input
                  type="checkbox"
                  aria-label="Tout sélectionner"
                  checked={allVisibleSelected}
                  ref={el => { if (el) el.indeterminate = someVisibleSelected }}
                  onChange={toggleAllVisible}
                  className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500 cursor-pointer"
                />
              </div>
            )}
            {visibleColumns.map(col => {
              const customField = customFieldsByColumn?.get(col.field) || customFieldsByColumn?.get(col.id)
              return (
                <div
                  key={col.id}
                  draggable
                  onDragStart={e => handleColDragStart(e, col.id)}
                  onDragOver={e => handleColDragOver(e, col.id)}
                  onDrop={handleColDrop}
                  onDragEnd={handleColDragEnd}
                  onDragLeave={() => setDragOverCol(prev => prev === col.id ? null : prev)}
                  onContextMenu={customField ? (e) => {
                    e.preventDefault()
                    setColMenu({ x: e.clientX, y: e.clientY, field: customField })
                  } : undefined}
                  className="relative px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wide leading-tight break-words select-none cursor-grab active:cursor-grabbing"
                  title={customField ? 'Clic-droit pour modifier ou supprimer' : undefined}
                >
                  {col.label}
                  {dragOverCol === col.id && dragColRef.current && dragColRef.current !== col.id && (
                    <div
                      className={`absolute top-0 bottom-0 w-0.5 bg-brand-500 pointer-events-none ${dragOverSide === 'before' ? '-left-px' : '-right-px'}`}
                    />
                  )}
                  <ResizeHandle onResize={w => handleColResize(col.id, w)} />
                </div>
              )
            })}
            {onAddCustomField && (
              <div className="flex items-center justify-center">
                <button
                  type="button"
                  onClick={onAddCustomField}
                  className="p-1 rounded text-slate-400 hover:text-brand-600 hover:bg-brand-50 transition-colors"
                  title="Ajouter un champ"
                  aria-label="Ajouter un champ"
                >
                  <Plus size={14} />
                </button>
              </div>
            )}
          </div>

          {colMenu && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setColMenu(null)} onContextMenu={e => { e.preventDefault(); setColMenu(null) }} />
              <div
                className="fixed z-50 bg-white border border-slate-200 rounded-lg shadow-lg py-1 min-w-[160px]"
                style={{ top: colMenu.y, left: colMenu.x }}
              >
                <button
                  onClick={() => { onEditCustomField?.(colMenu.field); setColMenu(null) }}
                  className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 text-left"
                >
                  <Edit2 size={13} /> Modifier
                </button>
                <button
                  onClick={() => { onDeleteCustomField?.(colMenu.field); setColMenu(null) }}
                  className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 text-left"
                >
                  <Trash2 size={13} /> Supprimer
                </button>
              </div>
            </>
          )}

          {loading ? (
            <div className="flex items-center justify-center text-slate-400 text-sm py-12">
              Chargement...
            </div>
          ) : virtualItems.length === 0 ? (
            <div className="flex items-center justify-center text-slate-400 text-sm py-12">
              Aucun résultat
            </div>
          ) : (
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map(vItem => {
              const item = virtualItems[vItem.index]

              if (item.__isGroup) {
                const sums = item.__sums || {}
                return (
                  <div
                    key={vItem.key}
                    style={{
                      position: 'absolute', top: vItem.start, left: 0, right: 0, height: vItem.size,
                      display: 'grid',
                      gridTemplateColumns: gridTemplate,
                      alignItems: 'center',
                    }}
                    className="bg-slate-100 border-b border-slate-200 cursor-pointer hover:bg-slate-200 transition-colors select-none"
                    onClick={() => toggleGroup(item.__key)}
                  >
                    {selectionActive && <div />}
                    <div className="flex items-center gap-2 px-3">
                      {item.__collapsed
                        ? <ChevronRight size={13} className="text-slate-400 flex-shrink-0" />
                        : <ChevronDown size={13} className="text-slate-400 flex-shrink-0" />
                      }
                      <span className="text-xs font-semibold text-slate-600 truncate">{item.__key}</span>
                      <span className="text-xs text-slate-400 flex-shrink-0">({item.__count})</span>
                    </div>
                    {visibleColumns.slice(1).map(col => (
                      <div key={col.id} className="px-4 text-xs tabular-nums">
                        {sums[col.field] != null && (
                          <span className="font-medium text-slate-500">
                            {sums[col.field].toLocaleString('fr-CA', { maximumFractionDigits: 2 })}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )
              }

              return (
                <div
                  key={vItem.key}
                  style={{
                    position: 'absolute',
                    top: vItem.start,
                    left: 0,
                    right: 0,
                    height: vItem.size,
                    display: 'grid',
                    gridTemplateColumns: gridTemplate,
                    alignItems: 'center',
                  }}
                  onClick={() => onRowClick?.(item)}
                  className="border-b border-slate-100 hover:bg-slate-50 cursor-pointer"
                >
                  {selectionActive && (
                    <div className="flex items-center justify-center px-2" onClick={e => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label="Sélectionner la ligne"
                        checked={selectedIds.has(item.id)}
                        onChange={() => toggleRow(item.id)}
                        className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500 cursor-pointer"
                      />
                    </div>
                  )}
                  {visibleColumns.map(col => (
                    <div key={col.id} className="px-4 truncate text-sm">
                      {col.render ? col.render(item) : col.dynamic ? <DynamicCell value={item[col.field]} col={col} /> : (item[col.field] ?? '—')}
                    </div>
                  ))}
                </div>
              )
            })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
