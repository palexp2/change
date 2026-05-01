import { useState, useEffect, useMemo } from 'react'
import api from './api.js'
import { useAuth } from './auth.jsx'
import { applyFilter, applyFilterGroup } from './tableFilters.js'

export { applyFilter, applyFilterGroup }

function norm(s) {
  return String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}
export function applySort(data, sorts, colTypes = {}) {
  if (!sorts.length) return data
  return [...data].sort((a, b) => {
    for (const { field, dir } of sorts) {
      const type = colTypes[field]
      const av = a[field], bv = b[field]
      let cmp
      if (type === 'date') {
        // Parse to epoch ms so naive-local (e.g. "2026-04-23T12:10:10") and
        // ISO-UTC (e.g. "2026-04-23T16:15:41.000Z") timestamps compare correctly.
        const an = av == null || av === '' ? -Infinity : new Date(av).getTime()
        const bn = bv == null || bv === '' ? -Infinity : new Date(bv).getTime()
        const ax = Number.isNaN(an) ? -Infinity : an
        const bx = Number.isNaN(bn) ? -Infinity : bn
        cmp = ax < bx ? -1 : ax > bx ? 1 : 0
      } else {
        cmp = String(av ?? '').localeCompare(String(bv ?? ''), undefined, { numeric: true })
      }
      if (cmp !== 0) return dir === 'asc' ? cmp : -cmp
    }
    return 0
  })
}

export function useTableView({ table, columns, data, searchFields = [], forceAllView = false }) {
  const { user } = useAuth()
  const userName = user?.name || null
  const [activeViewId, setActiveViewIdRaw] = useState(null)
  const [sorts, setSorts] = useState([])
  const [filters, setFilters] = useState([])
  const [search, setSearch] = useState('')
  const [views, setViews] = useState([])
  const [configReady, setConfigReady] = useState(false)
  const [adminConfig, setAdminConfig] = useState(null)
  const [dynamicFields, setDynamicFields] = useState([])

  const [allViewSortOrder, setAllViewSortOrder] = useState(-1)
  const [reloadKey, setReloadKey] = useState(0)

  // Reload when views are updated via TableConfigModal
  useEffect(() => {
    function onViewsUpdated(e) {
      if (e.detail?.table === table) setReloadKey(k => k + 1)
    }
    window.addEventListener('views:updated', onViewsUpdated)
    return () => window.removeEventListener('views:updated', onViewsUpdated)
  }, [table])

  useEffect(() => {
    api.views.get(table)
      .then(({ config, pills, dynamicFields: df }) => {
        setViews(pills)
        setAdminConfig(config)
        setAllViewSortOrder(config.all_view_sort_order ?? -1)
        setDynamicFields(df || [])
        const currentViewId = activeViewId
        const currentView = pills.find(p => p.id === currentViewId)
        if (currentView) {
          setSorts(currentView.sort?.length > 0 ? currentView.sort : (config.default_sort || []))
          setFilters(currentView.filters || [])
        } else if (pills.length > 0 && !forceAllView) {
          // Restore last selected view from localStorage, or fall back to first by sort_order
          const savedId = localStorage.getItem(`erp_lastView_${table}`)
          const savedView = savedId && pills.find(p => p.id === savedId)
          // savedId === 'null' means user explicitly chose "Tous"
          if (savedId === 'null') {
            setActiveViewIdRaw(null)
            setSorts(config.default_sort?.length > 0 ? config.default_sort : [])
            setFilters([])
          } else {
            const targetView = savedView || [...pills].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))[0]
            setActiveViewIdRaw(targetView.id)
            setSorts(targetView.sort?.length > 0 ? targetView.sort : (config.default_sort || []))
            setFilters(targetView.filters || [])
          }
        } else {
          setActiveViewIdRaw(null)
          setSorts(config.default_sort?.length > 0 ? config.default_sort : [])
          setFilters([])
        }
        setConfigReady(true)
      })
      .catch(() => {
        setAdminConfig({ visible_columns: [], default_sort: [] })
        setConfigReady(true)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, reloadKey])

  function setActiveViewId(id, currentViews, currentConfig) {
    const vList = currentViews ?? views
    const cfg = currentConfig ?? adminConfig
    // Persist current view's state in local array before switching
    if (activeViewId && activeViewId !== id) {
      setViews(prev => prev.map(v =>
        v.id === activeViewId ? { ...v, filters, sort: sorts } : v
      ))
    }
    setActiveViewIdRaw(id)
    localStorage.setItem(`erp_lastView_${table}`, String(id))
    if (id === null) {
      setSorts(cfg?.default_sort?.length > 0 ? cfg.default_sort : [])
      setFilters([])
    } else {
      const view = vList.find(v => v.id === id)
      if (view) {
        setSorts(view.sort?.length > 0 ? view.sort : (cfg?.default_sort || []))
        setFilters(view.filters || [])
      }
    }
  }

  const activeView = activeViewId === null ? null : (views.find(v => v.id === activeViewId) || null)

  // Merge hardcoded columns with dynamic Airtable fields
  const allColumns = useMemo(() => {
    if (!dynamicFields.length) return columns
    const existingIds = new Set(columns.map(c => c.id))
    const existingLabels = new Set(columns.map(c => c.label))
    const extra = dynamicFields
      .filter(f => !existingIds.has(f.id) && !existingLabels.has(f.label))
      .map(f => ({
        ...f,
        defaultVisible: (f.sort_order != null && f.sort_order < 0) ? true : false,
      }))
    return [...columns, ...extra]
  }, [columns, dynamicFields])

  const viewVisibleColumns = useMemo(() => {
    if (activeView?.visible_columns?.length > 0) return activeView.visible_columns
    if (activeViewId === null) {
      try {
        const saved = JSON.parse(localStorage.getItem(`erp_allView_cols_${table}`) || 'null')
        if (Array.isArray(saved) && saved.length > 0) return saved
      } catch {}
    }
    if (adminConfig?.visible_columns?.length > 0) return adminConfig.visible_columns
    return allColumns.filter(c => c.defaultVisible !== false).map(c => c.id)
  }, [activeView, activeViewId, adminConfig, allColumns, table])

  const viewGroupBy = activeView?.group_by || null

  const filteredData = useMemo(() => {
    let result = data
    if (search && searchFields.length > 0) {
      const q = norm(search)
      result = result.filter(row => searchFields.some(f => norm(row[f]).includes(q)))
    }
    const ctx = { userName }
    // Support both flat array format and nested group format
    if (filters?.conjunction && filters?.rules) {
      result = result.filter(row => applyFilterGroup(row, filters, ctx))
    } else if (Array.isArray(filters) && filters.length > 0) {
      result = result.filter(row => filters.every(f => applyFilter(row, f, ctx)))
    }
    const colTypes = Object.fromEntries(allColumns.map(c => [c.field, c.type]))
    result = applySort(result, sorts, colTypes)
    return result
  }, [data, search, searchFields, filters, sorts, userName, allColumns])

  function reorderViews(newViews, newAllViewSortOrder) {
    const realViews = newViews.filter(v => v.id !== null).map((v, i) => ({ ...v, sort_order: i }))
    setViews(realViews)
    if (newAllViewSortOrder !== undefined) setAllViewSortOrder(newAllViewSortOrder)
    const order = realViews.map((v, i) => ({ id: v.id, sort_order: i }))
    api.views.reorderPills(table, order, newAllViewSortOrder).catch(() => {})
  }

  return {
    filteredData,
    configReady,
    adminConfig,
    sorts, setSorts,
    filters, setFilters,
    search, setSearch,
    views,
    allViewSortOrder,
    reorderViews,
    activeViewId,
    setActiveViewId,
    activeView,
    viewVisibleColumns,
    viewGroupBy,
    allColumns,
    dynamicFields,
    columnWidths: adminConfig?.column_widths || {},
    bulkDeleteEnabled: adminConfig?.bulk_delete_enabled === true,
  }
}
