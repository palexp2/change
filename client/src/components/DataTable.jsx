import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronRight, ChevronDown } from 'lucide-react'
import { useTableView } from '../lib/useTableView.js'
import { ViewToolbar } from './ViewToolbar.jsx'
import { TABLE_ALL_LABEL } from '../lib/tableDefs.js'
import api from '../lib/api.js'

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
        {items.map((v, i) => <span key={i} className="text-xs px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700">{v}</span>)}
      </div>
    )
  }
  if (type === 'checkbox') {
    return <span>{value === 1 || value === true || value === '1' ? '✓' : '—'}</span>
  }
  if (type === 'date') {
    try { return <span className="text-slate-500 text-sm">{new Date(value).toLocaleDateString('fr-CA')}</span> } catch { return <span>{value}</span> }
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
      className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize z-10 bg-transparent group-hover/header:bg-slate-200 hover:!bg-indigo-400 active:!bg-indigo-500"
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
}) {
  const [visibleCols, setVisibleCols] = useState([])
  const [groupBy, setGroupBy] = useState(initialGroupBy)
  const [collapsedGroups, setCollapsedGroups] = useState(new Set())
  const [colWidths, setColWidths] = useState({})

  const view = useTableView({ table, columns, data, searchFields, forceAllView })
  const { filteredData, configReady, allColumns } = view
  // Use allColumns (hardcoded + dynamic Airtable fields) everywhere
  const mergedColumns = allColumns || columns

  const parentRef = useRef(null)
  const saveWidthsTimer = useRef(null)

  // Load persisted column widths from config
  useEffect(() => {
    if (!view.configReady) return
    if (view.columnWidths && Object.keys(view.columnWidths).length > 0) {
      setColWidths(view.columnWidths)
    }
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
  }, [view.activeViewId, view.configReady])

  const visibleColumns = useMemo(
    () => mergedColumns.filter(c => visibleCols.includes(c.id)),
    [mergedColumns, visibleCols]
  )

  const gridTemplate = useMemo(
    () => visibleColumns.map(c => colWidths[c.id] ? `${colWidths[c.id]}px` : '1fr').join(' '),
    [visibleColumns, colWidths]
  )

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
      />

      <div
        className="group/header grid border-b border-slate-200 bg-slate-50"
        style={{ gridTemplateColumns: gridTemplate }}
      >
        {visibleColumns.map(col => (
          <div key={col.id} className="relative px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wide truncate select-none">
            {col.label}
            <ResizeHandle onResize={w => handleColResize(col.id, w)} />
          </div>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center text-slate-400 text-sm" style={{ height }}>
          Chargement...
        </div>
      ) : virtualItems.length === 0 ? (
        <div className="flex items-center justify-center text-slate-400 text-sm" style={{ height }}>
          Aucun résultat
        </div>
      ) : (
        <div ref={parentRef} className="overflow-auto" style={{ height }}>
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
                  {visibleColumns.map(col => (
                    <div key={col.id} className="px-4 truncate text-sm">
                      {col.render ? col.render(item) : col.dynamic ? <DynamicCell value={item[col.field]} col={col} /> : (item[col.field] ?? '—')}
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
