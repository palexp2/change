import { useState, useEffect, useMemo } from 'react'
import api from './api.js'

function norm(s) {
  return String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

export function applyFilter(row, { field, op, value }) {
  const v = row[field]
  const str = norm(v)
  const val = norm(value)
  switch (op) {
    case 'contains':     return str.includes(val)
    case 'not_contains': return !str.includes(val)
    case 'equals':       return str === val
    case 'not_equals':   return str !== val
    case 'gt':           return Number(v) > Number(value)
    case 'lt':           return Number(v) < Number(value)
    case 'is_empty':     return v === null || v === undefined || v === ''
    case 'is_not_empty': return v !== null && v !== undefined && v !== ''
    case 'is_true':      return v === 1 || v === true || v === '1'
    case 'is_false':     return v === 0 || v === false || v === '0' || v === null || v === undefined
    case 'before': {
      if (!v || !value) return false
      return new Date(v) < new Date(value)
    }
    case 'after': {
      if (!v || !value) return false
      return new Date(v) > new Date(value)
    }
    case 'last_n_days': {
      if (!v || !value) return false
      const d = new Date(v)
      const now = new Date()
      const cutoff = new Date(now - Number(value) * 86400000)
      return d >= cutoff && d <= now
    }
    case 'next_n_days': {
      if (!v || !value) return false
      const d = new Date(v)
      const now = new Date()
      const cutoff = new Date(now.getTime() + Number(value) * 86400000)
      return d >= now && d <= cutoff
    }
    default:             return true
  }
}

export function applySort(data, sorts) {
  if (!sorts.length) return data
  return [...data].sort((a, b) => {
    for (const { field, dir } of sorts) {
      const cmp = String(a[field] ?? '').localeCompare(String(b[field] ?? ''), undefined, { numeric: true })
      if (cmp !== 0) return dir === 'asc' ? cmp : -cmp
    }
    return 0
  })
}

export function useTableView({ table, columns, data, searchFields = [] }) {
  const [activeViewId, setActiveViewIdRaw] = useState(null)
  const [sorts, setSorts] = useState([])
  const [filters, setFilters] = useState([])
  const [search, setSearch] = useState('')
  const [views, setViews] = useState([])
  const [configReady, setConfigReady] = useState(false)
  const [adminConfig, setAdminConfig] = useState(null)

  useEffect(() => {
    api.views.get(table)
      .then(({ config, pills }) => {
        setViews(pills)
        setAdminConfig(config)
        if (pills.length > 0) {
          const first = pills[0]
          setActiveViewIdRaw(first.id)
          setSorts(first.sort?.length > 0 ? first.sort : (config.default_sort || []))
          setFilters(first.filters || [])
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
  }, [table])

  function setActiveViewId(id, currentViews, currentConfig) {
    const vList = currentViews ?? views
    const cfg = currentConfig ?? adminConfig
    setActiveViewIdRaw(id)
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

  const viewVisibleColumns = useMemo(() => {
    if (activeView?.visible_columns?.length > 0) return activeView.visible_columns
    if (adminConfig?.visible_columns?.length > 0) return adminConfig.visible_columns
    return columns.filter(c => c.defaultVisible !== false).map(c => c.id)
  }, [activeView, adminConfig, columns])

  const viewGroupBy = activeView?.group_by || null

  const filteredData = useMemo(() => {
    let result = data
    if (search && searchFields.length > 0) {
      const q = norm(search)
      result = result.filter(row => searchFields.some(f => norm(row[f]).includes(q)))
    }
    result = result.filter(row => filters.every(f => applyFilter(row, f)))
    result = applySort(result, sorts)
    return result
  }, [data, search, searchFields, filters, sorts])

  function reorderViews(newViews) {
    setViews(newViews)
    const order = newViews.map((v, i) => ({ id: v.id, sort_order: i }))
    api.views.reorderPills(table, order).catch(() => {})
  }

  return {
    filteredData,
    configReady,
    adminConfig,
    sorts, setSorts,
    filters, setFilters,
    search, setSearch,
    views,
    reorderViews,
    activeViewId,
    setActiveViewId,
    activeView,
    viewVisibleColumns,
    viewGroupBy,
  }
}
