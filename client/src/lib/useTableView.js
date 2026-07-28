import { useState, useEffect, useMemo } from 'react'
import api from './api.js'
import { useAuth } from './auth.jsx'
import { applyFilter, applyFilterGroup } from './tableFilters.js'

export { applyFilter, applyFilterGroup }

function norm(s) {
  return String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}
// Collator précompilé — ~10× plus rapide que String.prototype.localeCompare
// dans une boucle de tri (qui recompile le collator à chaque appel). Critique
// sur les grandes tables (ex. 14k+ contacts).
const stringCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'variant' })

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
        cmp = stringCollator.compare(av == null ? '' : String(av), bv == null ? '' : String(bv))
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
        setDynamicFields(df || [])
        const currentViewId = activeViewId
        const currentView = pills.find(p => p.id === currentViewId)
        if (currentView) {
          setSorts(currentView.sort?.length > 0 ? currentView.sort : (config.default_sort || []))
          setFilters(currentView.filters || [])
        } else if (pills.length > 0 && !forceAllView) {
          // Restore last selected view from localStorage, or fall back to first by sort_order.
          // Legacy `savedId === 'null'` (ancienne vue « Tous » retirée) → première pill.
          const savedId = localStorage.getItem(`erp_lastView_${table}`)
          const savedView = (savedId && savedId !== 'null') ? pills.find(p => p.id === savedId) : null
          const targetView = savedView || [...pills].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))[0]
          setActiveViewIdRaw(targetView.id)
          setSorts(targetView.sort?.length > 0 ? targetView.sort : (config.default_sort || []))
          setFilters(targetView.filters || [])
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
  const viewGroupOrder = activeView?.group_order || null

  // Sig stable du tableau searchFields — sinon le tableau littéral passé en prop
  // (ex. `searchFields={['first_name', ...]}` dans Contacts.jsx) invalide ce
  // useMemo à chaque render parent et, combiné à `onFilteredDataChange`, crée
  // une boucle de re-render coûteuse sur les grandes tables (14k+ contacts).
  const searchFieldsKey = searchFields.join('|')
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, search, searchFieldsKey, filters, sorts, userName, allColumns])

  function reorderViews(newViews) {
    const realViews = newViews.map((v, i) => ({ ...v, sort_order: i }))
    setViews(realViews)
    const order = realViews.map((v, i) => ({ id: v.id, sort_order: i }))
    api.views.reorderPills(table, order).catch(() => {})
  }

  // Met à jour le pill local après un autosave server-side. Sans ça, l'état
  // local `views` reste figé sur la version chargée à l'init : si l'utilisateur
  // change de vue puis revient, le `visible_columns` (etc.) lu en mémoire est
  // celui d'avant son drag, et l'autosave qui suit écrase silencieusement sa
  // dernière sauvegarde.
  function patchLocalView(viewId, patch) {
    setViews(prev => prev.map(v => v.id === viewId ? { ...v, ...patch } : v))
  }

  return {
    filteredData,
    configReady,
    adminConfig,
    sorts, setSorts,
    filters, setFilters,
    search, setSearch,
    views,
    patchLocalView,
    reorderViews,
    activeViewId,
    setActiveViewId,
    activeView,
    viewVisibleColumns,
    viewGroupBy,
    viewGroupOrder,
    allColumns,
    dynamicFields,
    // Largeurs persistées par vue : priorité à la pill active ; fallback sur le
    // column_widths legacy de table_view_configs (vue « Tous »/forceAllView et
    // vues pas encore redimensionnées). Ainsi passer d'une vue à l'autre n'écrase
    // plus la mise en page de la précédente.
    columnWidths: (activeView?.column_widths && Object.keys(activeView.column_widths).length > 0)
      ? activeView.column_widths
      : (adminConfig?.column_widths || {}),
    footerAggregations: adminConfig?.footer_aggregations || {},
    bulkDeleteEnabled: adminConfig?.bulk_delete_enabled === true,
  }
}
