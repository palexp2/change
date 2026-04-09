import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronRight, ChevronDown } from 'lucide-react'
import { useTableView } from '../lib/useTableView.js'
import { ViewToolbar } from './ViewToolbar.jsx'
import { TABLE_ALL_LABEL } from '../lib/tableDefs.js'

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

  const view = useTableView({ table, columns, data, searchFields, forceAllView })
  const { filteredData, configReady, allColumns } = view
  // Use allColumns (hardcoded + dynamic Airtable fields) everywhere
  const mergedColumns = allColumns || columns

  const parentRef = useRef(null)

  // Apply view config when active view changes
  useEffect(() => {
    if (!view.configReady) return
    setVisibleCols(view.viewVisibleColumns)
    if (!forceAllView) setGroupBy(view.viewGroupBy)
  }, [view.activeViewId, view.configReady])

  const visibleColumns = useMemo(
    () => mergedColumns.filter(c => visibleCols.includes(c.id)),
    [mergedColumns, visibleCols]
  )

  const toggleGroup = useCallback(key => {
    setCollapsedGroups(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }, [])

  useEffect(() => { setCollapsedGroups(new Set()) }, [groupBy])

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
      flat.push({ __isGroup: true, __key: key, __count: rows.length, __collapsed: collapsed })
      if (!collapsed) flat.push(...rows)
    }
    return flat
  }, [filteredData, groupBy, collapsedGroups])

  const virtualizer = useVirtualizer({
    count: virtualItems.length,
    getScrollElement: () => parentRef.current,
    estimateSize: i => virtualItems[i]?.__isGroup ? 34 : 48,
    overscan: 12,
  })

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
        data={data}
      />

      <div
        className="grid border-b border-slate-200 bg-slate-50"
        style={{ gridTemplateColumns: visibleColumns.map(() => '1fr').join(' ') }}
      >
        {visibleColumns.map(col => (
          <div key={col.id} className="px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wide truncate">
            {col.label}
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
                return (
                  <div
                    key={vItem.key}
                    style={{ position: 'absolute', top: vItem.start, left: 0, right: 0, height: vItem.size }}
                    className="flex items-center gap-2 px-3 bg-slate-100 border-b border-slate-200 cursor-pointer hover:bg-slate-200 transition-colors select-none"
                    onClick={() => toggleGroup(item.__key)}
                  >
                    {item.__collapsed
                      ? <ChevronRight size={13} className="text-slate-400 flex-shrink-0" />
                      : <ChevronDown size={13} className="text-slate-400 flex-shrink-0" />
                    }
                    <span className="text-xs font-semibold text-slate-600">{item.__key}</span>
                    <span className="text-xs text-slate-400">({item.__count})</span>
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
                    gridTemplateColumns: visibleColumns.map(() => '1fr').join(' '),
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
