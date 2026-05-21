import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronRight, ChevronDown, Trash2, Plus, Edit2, Layers, Filter, ArrowUp, ArrowDown, EyeOff } from 'lucide-react'
import { useTableView } from '../lib/useTableView.js'
import { ViewToolbar } from './ViewToolbar.jsx'
import { defaultOpForType } from './FilterRow.jsx'
import api from '../lib/api.js'
import { fmtDate } from '../lib/formatDate.js'
import { useConfirm } from './ConfirmProvider.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import AirtableFieldEditModal from './AirtableFieldEditModal.jsx'

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
    // Tolère les multiples formes héritées : 1/true (sync récente),
    // '1' (cast SQLite TEXT), '1.0' (ancien parseFloat de la sync legacy).
    const truthy = value === 1 || value === true || value === '1' || value === '1.0' || Number(value) === 1
    return <span>{truthy ? '✓' : '—'}</span>
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
      return <img src={str} alt="" className="h-6 w-6 object-cover rounded" loading="lazy" />
    }
  }
  // text, long_text, link, etc.
  const str = String(value)
  return <span className="truncate">{str.length > 100 ? str.slice(0, 100) + '…' : str}</span>
}

// Normalise groupBy en tableau de field names. Accepte legacy string / null
// / array. Filtre les valeurs vides pour éviter les niveaux fantômes.
function normalizeGroupBy(g) {
  if (g == null) return []
  if (Array.isArray(g)) return g.filter(Boolean)
  return g ? [g] : []
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
  initialGroupOrder = null, // 'asc' | 'desc' | 'default' | array (aligné sur initialGroupBy)
  forceAllView = false,
  onBulkDelete,
  disabledColumns = null, // Map<column_name, { airtable_field_name }> | null
  onAddCustomField,       // () => void — affiche le bouton "+" en bout de header
  customFieldsByColumn,   // Map<column_name, { id, name, type, decimals }> — pour right-click menu
  onEditCustomField,      // (field) => void
  onDeleteCustomField,    // (field) => void
  onFilteredDataChange,   // (rows) => void — notifie le parent à chaque update de la vue filtrée
}) {
  const [visibleCols, setVisibleCols] = useState([])
  // groupBy : tableau de field names. Hérité du legacy : accepte aussi null /
  // string (single-level) et normalise vers array. Tableau vide = pas de
  // groupage. Plusieurs niveaux = groupage imbriqué.
  const [groupBy, setGroupByRaw] = useState(() => normalizeGroupBy(initialGroupBy))
  // groupOrder : tableau de ('asc' | 'desc' | 'default' | null) par niveau.
  // Aligné sur groupBy. Niveau manquant = 'default'.
  const [groupOrder, setGroupOrderRaw] = useState(() => {
    if (initialGroupOrder == null) return []
    return Array.isArray(initialGroupOrder) ? initialGroupOrder : [initialGroupOrder]
  })
  const [collapsedGroups, setCollapsedGroups] = useState(new Set())
  const [colWidths, setColWidths] = useState({})
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [deleting, setDeleting] = useState(false)
  const [colMenu, setColMenu] = useState(null) // { x, y, source: 'custom'|'airtable', field } pour right-click menu
  const [airtableEditField, setAirtableEditField] = useState(null) // field passé à AirtableFieldEditModal
  // Tracks previously seen custom-field column ids so we can auto-show newly
  // created fields in the active view (the user vient de créer le champ, on
  // suppose qu'ils veulent le voir tout de suite).
  const prevCustomFieldKeys = useRef(null)
  const confirm = useConfirm()
  const { addToast } = useToast()

  const view = useTableView({ table, columns, data, searchFields, forceAllView })
  const { filteredData, configReady, allColumns, bulkDeleteEnabled, airtableFieldsByColumn } = view

  useEffect(() => {
    if (typeof onFilteredDataChange === 'function') onFilteredDataChange(filteredData)
  }, [filteredData, onFilteredDataChange])
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

  // Wrappers : autorisent l'appelant à passer string|array|null (ergonomie
  // legacy), normalisent vers array en interne.
  const setGroupBy = useCallback(v => setGroupByRaw(normalizeGroupBy(v)), [])
  const setGroupOrder = useCallback(v => {
    if (v == null) setGroupOrderRaw([])
    else if (Array.isArray(v)) setGroupOrderRaw(v)
    else setGroupOrderRaw([v])
  }, [])

  // Apply view config when active view changes
  useEffect(() => {
    if (!view.configReady) return
    setVisibleCols(view.viewVisibleColumns)
    if (!forceAllView) {
      const newGroupBy = normalizeGroupBy(view.viewGroupBy)
      setGroupByRaw(newGroupBy)
      const o = view.viewGroupOrder
      setGroupOrderRaw(o == null ? [] : Array.isArray(o) ? o : [o])
      // Sync prevGroupByRef avec la nouvelle signature pour éviter que le
      // useEffect [groupBySig] détecte un changement et reset les groupes
      // collapsés qu'on est en train de restaurer depuis le serveur.
      prevGroupByRef.current = newGroupBy.join('|')
      // Restore collapsed groups : priorité au state sauvé sur la pill (sync
      // cross-device), fallback localStorage pour le legacy. Quand aucun des
      // deux n'est dispo on part déplié.
      let initial = null
      const persisted = view.activeView?.collapsed_groups
      if (Array.isArray(persisted)) {
        initial = persisted
      } else {
        try {
          const key = `erp_collapsed_${table}_${view.activeViewId || '__all__'}`
          initial = JSON.parse(localStorage.getItem(key) || '[]')
        } catch { initial = [] }
      }
      setCollapsedGroups(new Set(initial || []))
    } else {
      // forceAllView : pas de pill server-side, localStorage uniquement.
      try {
        const key = `erp_collapsed_${table}_forceAll`
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

  // Clé localStorage : conserve la persistence locale comme fallback (utile
  // pour forceAllView, ou comme cache rapide avant la réponse serveur).
  const collapsedStorageKey = forceAllView
    ? `erp_collapsed_${table}_forceAll`
    : `erp_collapsed_${table}_${view.activeViewId || '__all__'}`
  const storageKeyRef = useRef(collapsedStorageKey)
  storageKeyRef.current = collapsedStorageKey

  // Debounce le save serveur des collapsed_groups : l'utilisateur peut
  // cliquer rapidement plusieurs groupes d'affilée, on bundle les writes.
  const saveCollapsedTimer = useRef(null)
  const activeViewIdRef = useRef(view.activeViewId)
  activeViewIdRef.current = view.activeViewId

  function saveCollapsed(set) {
    try { localStorage.setItem(storageKeyRef.current, JSON.stringify([...set])) } catch {}
    // Persiste côté serveur si une pill est active (sinon : pas de pill =
    // pas de stockage server, fallback localStorage seulement).
    if (!forceAllView && activeViewIdRef.current) {
      clearTimeout(saveCollapsedTimer.current)
      const viewId = activeViewIdRef.current
      const arr = [...set]
      saveCollapsedTimer.current = setTimeout(() => {
        api.views.updatePill(table, viewId, { collapsed_groups: arr }).catch(() => {})
      }, 400)
    }
  }

  const toggleGroup = useCallback(key => {
    setCollapsedGroups(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      saveCollapsed(next)
      return next
    })
  }, [])

  // groupBy changeant (identité du tableau OU son contenu) → on reset les
  // groupes collapsés pour repartir d'un état déplié propre.
  const groupBySig = groupBy.join('|')
  const prevGroupByRef = useRef(groupBySig)
  useEffect(() => {
    if (prevGroupByRef.current !== groupBySig) {
      setCollapsedGroups(new Set())
      prevGroupByRef.current = groupBySig
    }
  }, [groupBySig])

  const numberColumns = useMemo(
    () => mergedColumns.filter(c => c.type === 'number' || c.type === 'currency'),
    [mergedColumns]
  )

  const virtualItems = useMemo(() => {
    if (!groupBy.length) return filteredData

    const cmpAlpha = (a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base', numeric: true })

    // Construction récursive : pour chaque niveau, on regroupe les rows par
    // la valeur du champ courant, on ordonne les clés, on émet le header
    // puis (si déplié) les enfants — soit le niveau suivant, soit les rows.
    // pathKey = clés du niveau 0 jusqu'à ce niveau, jointes par '||' ; sert
    // d'identifiant unique pour le set `collapsedGroups`.
    function buildLevel(rows, levelIdx, parentPath) {
      if (levelIdx >= groupBy.length) return rows
      const field = groupBy[levelIdx]
      const order = groupOrder[levelIdx] || null

      const groups = new Map()
      for (const row of rows) {
        const k = String(row[field] ?? '(vide)')
        if (!groups.has(k)) groups.set(k, [])
        groups.get(k).push(row)
      }

      const groupCol = mergedColumns.find(c => c.field === field)
      const hasOptions = Array.isArray(groupCol?.options) && groupCol.options.length > 0
      let keys = [...groups.keys()]
      if (order === 'asc') {
        keys.sort(cmpAlpha)
      } else if (order === 'desc') {
        keys.sort(cmpAlpha).reverse()
      } else if (hasOptions) {
        const orderIdx = new Map(groupCol.options.map((o, i) => [String(o), i]))
        keys.sort((a, b) => {
          const ia = orderIdx.has(a) ? orderIdx.get(a) : Number.MAX_SAFE_INTEGER
          const ib = orderIdx.has(b) ? orderIdx.get(b) : Number.MAX_SAFE_INTEGER
          if (ia !== ib) return ia - ib
          return cmpAlpha(a, b)
        })
      } else {
        keys.sort(cmpAlpha)
      }

      const flat = []
      for (const key of keys) {
        const groupRows = groups.get(key)
        const path = parentPath ? `${parentPath}||${key}` : key
        const collapsed = collapsedGroups.has(path)

        const sums = {}
        if (numberColumns.length > 0) {
          for (const col of numberColumns) {
            let total = 0
            for (const row of groupRows) {
              const v = parseFloat(row[col.field])
              if (!isNaN(v)) total += v
            }
            if (total !== 0) sums[col.field] = total
          }
        }

        flat.push({
          __isGroup: true,
          __key: key,
          __pathKey: path,
          __level: levelIdx,
          __count: groupRows.length,
          __collapsed: collapsed,
          __sums: sums,
        })
        if (!collapsed) {
          flat.push(...buildLevel(groupRows, levelIdx + 1, path))
        }
      }
      return flat
    }

    return buildLevel(filteredData, 0, null)
  }, [filteredData, groupBy, groupOrder, collapsedGroups, numberColumns, mergedColumns])

  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: virtualItems.length,
    getScrollElement: () => parentRef.current,
    estimateSize: i => virtualItems[i]?.__isGroup ? 26 : 32,
    overscan: 12,
  })

  // Tous les pathKeys actuellement matérialisés (utile pour "Tout fermer").
  // Note : avec le nested grouping, ne contient que les groupes des niveaux
  // dépliés — un groupe parent fermé masque ses enfants donc ils n'apparaissent
  // pas ici. "Tout fermer" sur les niveaux visibles est suffisant ; un second
  // appel après que l'utilisateur ait déplié des niveaux fermera ceux-là.
  const groupKeys = useMemo(
    () => virtualItems.filter(i => i.__isGroup).map(i => i.__pathKey),
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
        onReorderViews={view.reorderViews}
        activeViewId={view.activeViewId}
        setActiveViewId={view.setActiveViewId}
        processedCount={filteredData.length}
        visibleCols={visibleCols} setVisibleCols={setVisibleCols}
        groupBy={groupBy} setGroupBy={setGroupBy}
        groupOrder={groupOrder} setGroupOrder={setGroupOrder}
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
              const airtableField = !customField && (airtableFieldsByColumn?.get(col.field) || airtableFieldsByColumn?.get(col.id))
              const editable = customField || airtableField
              return (
                <div
                  key={col.id}
                  draggable
                  onDragStart={e => handleColDragStart(e, col.id)}
                  onDragOver={e => handleColDragOver(e, col.id)}
                  onDrop={handleColDrop}
                  onDragEnd={handleColDragEnd}
                  onDragLeave={() => setDragOverCol(prev => prev === col.id ? null : prev)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setColMenu({
                      x: e.clientX,
                      y: e.clientY,
                      col,
                      source: customField ? 'custom' : (airtableField ? 'airtable' : null),
                      field: editable || null,
                    })
                  }}
                  className="relative px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wide leading-tight break-words select-none cursor-grab active:cursor-grabbing"
                  title="Clic-droit pour grouper, filtrer, trier ou cacher"
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

          {colMenu && (() => {
            const c = colMenu.col
            const canGroup = c?.groupable !== false && c?.field
            const canSort = c?.sortable !== false && c?.field
            const canFilter = c?.filterable !== false && c?.field
            const itemCls = 'flex items-center gap-2 w-full px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 text-left'
            return (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setColMenu(null)} onContextMenu={e => { e.preventDefault(); setColMenu(null) }} />
                <div
                  className="fixed z-50 bg-white border border-slate-200 rounded-lg shadow-lg py-1 min-w-[200px]"
                  style={{ top: colMenu.y, left: colMenu.x }}
                >
                  {canGroup && (
                    <button onClick={() => { setGroupBy(c.field); setColMenu(null) }} className={itemCls}>
                      <Layers size={13} /> Grouper par cette colonne
                    </button>
                  )}
                  {canFilter && (
                    <button
                      onClick={() => {
                        const op = defaultOpForType(c.type)
                        const newRule = { field: c.field, op, value: '' }
                        const cur = view.filters
                        const nextFilters = (cur && cur.rules)
                          ? { ...cur, rules: [...cur.rules, newRule] }
                          : (Array.isArray(cur) ? [...cur, newRule] : [newRule])
                        view.setFilters(nextFilters)
                        window.dispatchEvent(new CustomEvent('datatable:open-panel', { detail: { table, panel: 'filter' } }))
                        setColMenu(null)
                      }}
                      className={itemCls}
                    >
                      <Filter size={13} /> Filtrer cette colonne
                    </button>
                  )}
                  {canSort && (
                    <button onClick={() => { view.setSorts([{ field: c.field, dir: 'asc' }]); setColMenu(null) }} className={itemCls}>
                      <ArrowUp size={13} /> Trier croissant
                    </button>
                  )}
                  {canSort && (
                    <button onClick={() => { view.setSorts([{ field: c.field, dir: 'desc' }]); setColMenu(null) }} className={itemCls}>
                      <ArrowDown size={13} /> Trier décroissant
                    </button>
                  )}
                  <button
                    onClick={() => {
                      setVisibleCols(prev => prev.filter(id => id !== c.id))
                      setColMenu(null)
                    }}
                    className={itemCls}
                  >
                    <EyeOff size={13} /> Cacher cette colonne
                  </button>
                  {colMenu.source && (
                    <>
                      <div className="my-1 border-t border-slate-100" />
                      <button
                        onClick={() => {
                          if (colMenu.source === 'airtable') setAirtableEditField(colMenu.field)
                          else onEditCustomField?.(colMenu.field)
                          setColMenu(null)
                        }}
                        className={itemCls}
                      >
                        <Edit2 size={13} /> {colMenu.source === 'airtable' ? 'Modifier le type' : 'Modifier le champ'}
                      </button>
                      <button
                        onClick={async () => {
                          const f = colMenu.field
                          const src = colMenu.source
                          setColMenu(null)
                          if (src === 'airtable') {
                            const ok = await confirm(`Supprimer la colonne "${f.label}" ? Cette action est irréversible — la colonne et toutes ses données seront perdues.`)
                            if (!ok) return
                            try {
                              await api.airtableFields.delete(f.id)
                              addToast({ message: 'Colonne supprimée', type: 'success' })
                              window.dispatchEvent(new CustomEvent('views:updated', { detail: { table } }))
                            } catch (e) {
                              addToast({ message: e.message || 'Erreur', type: 'error' })
                            }
                          } else {
                            onDeleteCustomField?.(f)
                          }
                        }}
                        className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 text-left"
                      >
                        <Trash2 size={13} /> Supprimer le champ
                      </button>
                    </>
                  )}
                </div>
              </>
            )
          })()}

          <AirtableFieldEditModal
            isOpen={!!airtableEditField}
            field={airtableEditField}
            onClose={() => setAirtableEditField(null)}
            onSaved={() => {
              setAirtableEditField(null)
              window.dispatchEvent(new CustomEvent('views:updated', { detail: { table } }))
            }}
          />

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
                // Niveau 0 = la teinte la plus marquée ; chaque niveau imbriqué
                // s'éclaircit légèrement pour visualiser la hiérarchie. Cap au
                // niveau 2 pour éviter de devenir invisible.
                const lvl = item.__level || 0
                // Reformate la clé du groupe via la colonne du niveau (utile
                // pour ex. afficher "mai 2026" pour un YYYY-MM ou "Upgrade"
                // pour la catégorie brute "upgrade").
                const lvlField = groupBy[lvl]
                const lvlCol = lvlField ? mergedColumns.find(c => c.field === lvlField) : null
                const groupLabel = lvlCol?.formatGroupKey
                  ? lvlCol.formatGroupKey(item.__key)
                  : item.__key
                const groupBg = lvl === 0
                  ? 'bg-slate-100 hover:bg-slate-200'
                  : lvl === 1
                    ? 'bg-slate-50 hover:bg-slate-100'
                    : 'bg-white hover:bg-slate-50'
                return (
                  <div
                    key={vItem.key}
                    data-testid={`datatable-group-${item.__pathKey}`}
                    data-group-level={lvl}
                    style={{
                      position: 'absolute', top: vItem.start, left: 0, right: 0, height: vItem.size,
                      display: 'grid',
                      gridTemplateColumns: gridTemplate,
                      alignItems: 'center',
                    }}
                    className={`${groupBg} border-b border-slate-200 cursor-pointer transition-colors select-none`}
                    onClick={() => toggleGroup(item.__pathKey)}
                  >
                    {selectionActive && <div />}
                    <div className="flex items-center gap-2 px-3" style={{ paddingLeft: `${12 + lvl * 16}px` }}>
                      {item.__collapsed
                        ? <ChevronRight size={13} className="text-slate-400 flex-shrink-0" />
                        : <ChevronDown size={13} className="text-slate-400 flex-shrink-0" />
                      }
                      <span className="text-xs font-semibold text-slate-600 truncate capitalize">{groupLabel}</span>
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
