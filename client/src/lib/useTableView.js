import { useState, useEffect, useMemo } from 'react'
import api from './api.js'
import { useAuth } from './auth.jsx'

function norm(s) {
  return String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

export function applyFilter(row, filter, ctx = {}) {
  // Support both old format {field, op, value} and new format {field_key, operator, value}
  const field = filter.field_key || filter.field
  const op = filter.operator || filter.op
  const value = filter.value
  const v = row[field]
  const str = norm(v)
  const val = norm(value)
  switch (op) {
    case 'is_me':        return ctx.userName ? str === norm(ctx.userName) : false
    case 'is_not_me':    return ctx.userName ? str !== norm(ctx.userName) : true
    case 'contains':     return str.includes(val)
    case 'not_contains': return !str.includes(val)
    case 'equals':
    case 'is':           return str === val
    case 'not_equals':
    case 'is_not':       return str !== val
    case 'starts_with':  return str.startsWith(val)
    case 'ends_with':    return str.endsWith(val)
    case 'eq':           return Number(v) === Number(value)
    case 'neq':          return Number(v) !== Number(value)
    case 'gt':           return Number(v) > Number(value)
    case 'gte':          return Number(v) >= Number(value)
    case 'lt':           return Number(v) < Number(value)
    case 'lte':          return Number(v) <= Number(value)
    case 'is_empty':     return v === null || v === undefined || v === '' || v === '[]'
    case 'is_not_empty': return v !== null && v !== undefined && v !== '' && v !== '[]'
    case 'is_true':      return v === 1 || v === true || v === '1'
    case 'is_false':     return v === 0 || v === false || v === '0' || v === null || v === undefined
    case 'is_before':
    case 'before': {
      if (!v || !value) return false
      return new Date(v) < new Date(value)
    }
    case 'is_after':
    case 'after': {
      if (!v || !value) return false
      return new Date(v) > new Date(value)
    }
    case 'is_any_of': {
      if (!value) return false
      const opts = Array.isArray(value) ? value : [value]
      return opts.some(o => norm(o) === str)
    }
    case 'is_none_of': {
      if (!value) return true
      const opts = Array.isArray(value) ? value : [value]
      return !opts.some(o => norm(o) === str)
    }
    case 'has_any_of': {
      const arr = tryParseArr(v)
      const opts = Array.isArray(value) ? value : [value]
      return opts.some(o => arr.includes(o))
    }
    case 'has_all_of': {
      const arr = tryParseArr(v)
      const opts = Array.isArray(value) ? value : [value]
      return opts.every(o => arr.includes(o))
    }
    case 'has_none_of': {
      const arr = tryParseArr(v)
      const opts = Array.isArray(value) ? value : [value]
      return !opts.some(o => arr.includes(o))
    }
    case 'is_exactly': {
      const arr = tryParseArr(v)
      const opts = Array.isArray(value) ? value : [value]
      return arr.length === opts.length && opts.every(o => arr.includes(o))
    }
    case 'last_n_days': {
      if (!v || !value) return false
      const d = new Date(v)
      const now = new Date()
      const cutoff = new Date(now - Number(value) * 86400000)
      return d >= cutoff && d <= now
    }
    case 'more_than_n_days_ago': {
      if (!v || !value) return false
      const d = new Date(v)
      const cutoff = new Date(Date.now() - Number(value) * 86400000)
      return d < cutoff
    }
    case 'next_n_days': {
      if (!v || !value) return false
      const d = new Date(v)
      const now = new Date()
      const cutoff = new Date(now.getTime() + Number(value) * 86400000)
      return d >= now && d <= cutoff
    }
    case 'more_than_n_days_ahead': {
      if (!v || !value) return false
      const d = new Date(v)
      const cutoff = new Date(Date.now() + Number(value) * 86400000)
      return d > cutoff
    }
    case 'today': {
      if (!v) return false
      const d = new Date(v).toISOString().slice(0, 10)
      const t = new Date().toISOString().slice(0, 10)
      return d === t
    }
    case 'yesterday': {
      if (!v) return false
      const d = new Date(v).toISOString().slice(0, 10)
      const y = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
      return d === y
    }
    case 'this_week': {
      if (!v) return false
      const d = new Date(v)
      const now = new Date()
      const day = now.getDay()
      const start = new Date(now)
      start.setDate(now.getDate() - (day === 0 ? 6 : day - 1))
      start.setHours(0, 0, 0, 0)
      const end = new Date(start)
      end.setDate(start.getDate() + 7)
      return d >= start && d < end
    }
    case 'this_month': {
      if (!v) return false
      const d = new Date(v)
      const now = new Date()
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()
    }
    case 'last_month': {
      if (!v) return false
      const d = new Date(v)
      const now = new Date()
      const lm = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      return d.getMonth() === lm.getMonth() && d.getFullYear() === lm.getFullYear()
    }
    default:             return true
  }
}

function tryParseArr(v) {
  if (Array.isArray(v)) return v
  if (typeof v === 'string' && v.startsWith('[')) {
    try { return JSON.parse(v) } catch { return [] }
  }
  return v ? [v] : []
}

// Apply a nested filter group (conjunction + rules) to a row
function applyFilterGroup(row, group, ctx = {}) {
  if (!group?.rules?.length) return true
  const method = group.conjunction === 'OR' ? 'some' : 'every'
  return group.rules[method](rule => {
    if (rule.conjunction && rule.rules) return applyFilterGroup(row, rule, ctx)
    return applyFilter(row, rule, ctx)
  })
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
