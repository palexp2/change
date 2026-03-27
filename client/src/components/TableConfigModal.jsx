import { useState, useEffect } from 'react'
import { Settings, Plus, X, ChevronUp, ChevronDown } from 'lucide-react'
import { useAuth } from '../lib/auth.jsx'
import api from '../lib/api.js'
import { TABLE_COLUMN_META, TABLE_LABELS, TABLE_ALL_LABEL } from '../lib/tableDefs.js'
import { Modal } from './Modal.jsx'

const FILTER_OPS = [
  { value: 'contains',     label: 'Contient' },
  { value: 'not_contains', label: 'Ne contient pas' },
  { value: 'equals',       label: 'Est égal à' },
  { value: 'not_equals',   label: "N'est pas égal à" },
  { value: 'gt',           label: 'Supérieur à' },
  { value: 'lt',           label: 'Inférieur à' },
  { value: 'is_empty',     label: 'Est vide' },
  { value: 'is_not_empty', label: "N'est pas vide" },
]
const VALUE_LESS = new Set(['is_empty', 'is_not_empty'])

const PILL_COLORS = [
  { value: 'gray',   bg: 'bg-slate-400'  },
  { value: 'blue',   bg: 'bg-blue-500'   },
  { value: 'green',  bg: 'bg-green-500'  },
  { value: 'red',    bg: 'bg-red-500'    },
  { value: 'yellow', bg: 'bg-yellow-400' },
  { value: 'purple', bg: 'bg-purple-500' },
  { value: 'orange', bg: 'bg-orange-400' },
]
const pillBg = color => PILL_COLORS.find(c => c.value === color)?.bg || 'bg-slate-400'

function ViewConfigEditor({ columns, current, selectedViewId, onSaveGlobal, onSaveView, saving }) {
  const isGlobal = selectedViewId === null

  const [globalCols, setGlobalCols]   = useState([])
  const [globalSorts, setGlobalSorts] = useState([])
  const [viewLabel, setViewLabel]     = useState('')
  const [viewColor, setViewColor]     = useState('blue')
  const [viewCols, setViewCols]       = useState([])
  const [viewSorts, setViewSorts]     = useState([])
  const [viewGroupBy, setViewGroupBy] = useState(null)
  const [viewFilters, setViewFilters] = useState([])

  useEffect(() => {
    if (isGlobal) {
      const preset = current.config.visible_columns?.length > 0
        ? current.config.visible_columns
        : columns.filter(c => c.defaultVisible !== false).map(c => c.id)
      setGlobalCols(preset)
      setGlobalSorts(current.config.default_sort || [])
    } else {
      const pill = current.pills.find(p => p.id === selectedViewId)
      if (!pill) return
      setViewLabel(pill.label)
      setViewColor(pill.color || 'blue')
      setViewCols(pill.visible_columns?.length > 0 ? pill.visible_columns : [])
      setViewSorts(pill.sort || [])
      setViewGroupBy(pill.group_by || null)
      setViewFilters(pill.filters || [])
    }
  }, [selectedViewId])

  function toggleCol(id) {
    if (isGlobal) setGlobalCols(v => v.includes(id) ? v.filter(x => x !== id) : [...v, id])
    else          setViewCols(v  => v.includes(id) ? v.filter(x => x !== id) : [...v, id])
  }

  function addSort() {
    const active = isGlobal ? globalSorts : viewSorts
    const setActive = isGlobal ? setGlobalSorts : setViewSorts
    const used = new Set(active.map(s => s.field))
    const next = columns.find(c => c.sortable !== false && c.field && !used.has(c.field))
    if (!next) return
    setActive(s => [...s, { field: next.field, dir: 'asc' }])
  }
  function updateSort(i, patch) {
    const setActive = isGlobal ? setGlobalSorts : setViewSorts
    setActive(s => s.map((item, idx) => idx === i ? { ...item, ...patch } : item))
  }
  function removeSort(i) {
    const setActive = isGlobal ? setGlobalSorts : setViewSorts
    setActive(s => s.filter((_, idx) => idx !== i))
  }

  function addFilter() {
    const first = columns.find(c => c.filterable !== false && c.field)
    setViewFilters(f => [...f, { field: first?.field || '', op: 'equals', value: '' }])
  }
  function updateFilter(i, patch) {
    setViewFilters(f => f.map((item, idx) => idx === i ? { ...item, ...patch } : item))
  }
  function removeFilter(i) {
    setViewFilters(f => f.filter((_, idx) => idx !== i))
  }

  function handleSave() {
    if (isGlobal) {
      onSaveGlobal({ visible_columns: globalCols, default_sort: globalSorts })
    } else {
      onSaveView(selectedViewId, {
        label: viewLabel,
        color: viewColor,
        visible_columns: viewCols,
        sort: viewSorts,
        group_by: viewGroupBy,
        filters: viewFilters,
      })
    }
  }

  const activeCols  = isGlobal ? globalCols  : viewCols
  const activeSorts = isGlobal ? globalSorts : viewSorts

  return (
    <div className="space-y-5">

      {/* Nom + couleur (vues personnalisées) */}
      {!isGlobal && (
        <div className="flex items-end gap-4">
          <div className="flex-1">
            <label className="label">Nom de la vue</label>
            <input value={viewLabel} onChange={e => setViewLabel(e.target.value)} className="input" />
          </div>
          <div>
            <label className="label">Couleur</label>
            <div className="flex gap-2 mt-1">
              {PILL_COLORS.map(c => (
                <button key={c.value} type="button" onClick={() => setViewColor(c.value)}
                  className={`w-6 h-6 rounded-full ${c.bg} transition-transform ${viewColor === c.value ? 'ring-2 ring-offset-1 ring-slate-400 scale-110' : 'hover:scale-105'}`} />
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">

        {/* Colonnes visibles */}
        <div>
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Colonnes visibles</p>
          {!isGlobal && activeCols.length === 0 && (
            <p className="text-xs text-slate-400 mb-2 italic">Aucune sélection → colonnes par défaut</p>
          )}
          <div className="space-y-0.5">
            {columns.map(col => (
              <label key={col.id} className="flex items-center gap-2.5 px-2 py-1.5 rounded hover:bg-slate-50 cursor-pointer">
                <input type="checkbox"
                  checked={activeCols.includes(col.id)}
                  onChange={() => toggleCol(col.id)}
                  className="rounded border-slate-300 text-indigo-600" />
                <span className="text-sm text-slate-700">{col.label || col.id}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Tri + Grouper + Filtres */}
        <div className="space-y-5">

          {/* Tri */}
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Tri par défaut</p>
            <div className="space-y-2">
              {activeSorts.length === 0 && <p className="text-sm text-slate-400">Aucun tri</p>}
              {activeSorts.map((s, i) => (
                <div key={i} className="flex items-center gap-2">
                  <select value={s.field} onChange={e => updateSort(i, { field: e.target.value })} className="select text-sm flex-1">
                    {columns.filter(c => c.sortable !== false && c.field).map(c => (
                      <option key={c.id} value={c.field}>{c.label}</option>
                    ))}
                  </select>
                  <button onClick={() => updateSort(i, { dir: s.dir === 'asc' ? 'desc' : 'asc' })}
                    className="flex items-center gap-1 px-2.5 py-1.5 text-xs border border-slate-200 rounded hover:bg-slate-50 text-slate-600">
                    {s.dir === 'asc' ? <><ChevronUp size={12} /> Croissant</> : <><ChevronDown size={12} /> Décroissant</>}
                  </button>
                  <button onClick={() => removeSort(i)} className="text-slate-300 hover:text-red-500"><X size={14} /></button>
                </div>
              ))}
              <button onClick={addSort} className="flex items-center gap-1.5 text-xs text-indigo-600 hover:text-indigo-800 font-medium mt-1">
                <Plus size={13} /> Ajouter un tri
              </button>
            </div>
          </div>

          {/* Grouper (vues personnalisées) */}
          {!isGlobal && (
            <div>
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Grouper par</p>
              <select value={viewGroupBy || ''} onChange={e => setViewGroupBy(e.target.value || null)} className="select text-sm w-full">
                <option value="">— Aucun groupement —</option>
                {columns.filter(c => c.groupable !== false && c.field).map(c => (
                  <option key={c.id} value={c.field}>{c.label}</option>
                ))}
              </select>
            </div>
          )}

          {/* Filtres (vues personnalisées) */}
          {!isGlobal && (
            <div>
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Filtres</p>
              <div className="space-y-2">
                {viewFilters.length === 0 && <p className="text-sm text-slate-400">Aucun filtre</p>}
                {viewFilters.map((f, i) => (
                  <div key={i} className="flex items-center gap-2 flex-wrap">
                    <select value={f.field} onChange={e => updateFilter(i, { field: e.target.value })} className="select text-sm flex-1 min-w-0">
                      {columns.filter(c => c.filterable !== false && c.field).map(c => (
                        <option key={c.id} value={c.field}>{c.label}</option>
                      ))}
                    </select>
                    <select value={f.op} onChange={e => updateFilter(i, { op: e.target.value })} className="select text-sm flex-1 min-w-0">
                      {FILTER_OPS.map(op => <option key={op.value} value={op.value}>{op.label}</option>)}
                    </select>
                    {!VALUE_LESS.has(f.op) && (
                      <input value={f.value} onChange={e => updateFilter(i, { value: e.target.value })}
                        className="input text-sm flex-1 min-w-0" placeholder="Valeur" />
                    )}
                    <button onClick={() => removeFilter(i)} className="text-slate-300 hover:text-red-500"><X size={14} /></button>
                  </div>
                ))}
                <button onClick={addFilter} className="flex items-center gap-1.5 text-xs text-indigo-600 hover:text-indigo-800 font-medium mt-1">
                  <Plus size={13} /> Ajouter un filtre
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <button onClick={handleSave} disabled={saving} className="btn-primary btn-sm">
        {saving ? 'Enregistrement...' : 'Sauvegarder'}
      </button>
    </div>
  )
}

export function TableConfigModal({ table }) {
  const { user } = useAuth()
  const [open, setOpen]               = useState(false)
  const [viewData, setViewData]       = useState(null)
  const [selectedViewId, setSelectedViewId] = useState(null)
  const [saving, setSaving]           = useState(false)
  const [addingView, setAddingView]   = useState(false)
  const [newViewName, setNewViewName] = useState('')

  if (user?.role !== 'admin') return null

  const columns = TABLE_COLUMN_META[table] || []
  const current = viewData || { config: { visible_columns: [], default_sort: [] }, pills: [] }

  useEffect(() => {
    if (!open) return
    setViewData(null)
    setSelectedViewId(null)
    api.views.get(table)
      .then(data => setViewData(data))
      .catch(() => setViewData({ config: { visible_columns: [], default_sort: [] }, pills: [] }))
  }, [open])

  async function handleSaveGlobal(data) {
    setSaving(true)
    try {
      await api.views.updateConfig(table, data)
      setViewData(v => ({ ...v, config: data }))
    } finally { setSaving(false) }
  }

  async function handleSaveView(id, form) {
    setSaving(true)
    try {
      const updated = await api.views.updatePill(table, id, form)
      setViewData(v => ({ ...v, pills: v.pills.map(p => p.id === id ? updated : p) }))
    } finally { setSaving(false) }
  }

  async function handleAddView() {
    if (!newViewName.trim()) return
    setSaving(true)
    try {
      const pill = await api.views.createPill(table, {
        label: newViewName.trim(),
        color: 'blue',
        filters: [],
        visible_columns: [],
        sort: [],
        group_by: null,
        sort_order: current.pills.length,
      })
      setViewData(v => ({ ...v, pills: [...v.pills, pill] }))
      setSelectedViewId(pill.id)
      setNewViewName('')
      setAddingView(false)
    } finally { setSaving(false) }
  }

  async function handleDeleteView(id) {
    if (!confirm('Supprimer cette vue ?')) return
    await api.views.deletePill(table, id)
    setViewData(v => ({ ...v, pills: v.pills.filter(p => p.id !== id) }))
    if (selectedViewId === id) setSelectedViewId(null)
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
        title="Configurer les vues de la table"
      >
        <Settings size={17} />
      </button>

      <Modal
        isOpen={open}
        onClose={() => setOpen(false)}
        title={`Vues — ${TABLE_LABELS[table] || table}`}
        size="xl"
      >
        <div className="-mx-6 -mb-4 flex min-h-[480px]">

          {/* Panneau gauche — liste des vues */}
          <div className="w-52 flex-shrink-0 border-r border-slate-200 flex flex-col overflow-hidden">
            <div className="flex-1 overflow-y-auto py-2">

              <button
                onClick={() => setSelectedViewId(null)}
                className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-left transition-colors ${
                  selectedViewId === null
                    ? 'bg-indigo-50 text-indigo-700 font-medium'
                    : 'text-slate-700 hover:bg-slate-50'
                }`}
              >
                <div className="w-2 h-2 rounded-full bg-slate-400 flex-shrink-0" />
                {TABLE_ALL_LABEL[table] || 'Tous'}
              </button>

              {current.pills.map(pill => (
                <div key={pill.id}
                  className={`group flex items-center gap-2 px-4 py-2.5 text-sm transition-colors ${
                    selectedViewId === pill.id
                      ? 'bg-indigo-50 text-indigo-700'
                      : 'text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  <button onClick={() => setSelectedViewId(pill.id)} className="flex items-center gap-2.5 flex-1 text-left min-w-0">
                    <div className={`w-2 h-2 rounded-full flex-shrink-0 ${pillBg(pill.color)}`} />
                    <span className="truncate font-medium">{pill.label}</span>
                  </button>
                  <button
                    onClick={() => handleDeleteView(pill.id)}
                    className="opacity-0 group-hover:opacity-100 p-0.5 text-slate-300 hover:text-red-500 flex-shrink-0 transition-opacity"
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>

            <div className="border-t border-slate-200 p-3 flex-shrink-0">
              {addingView ? (
                <div className="space-y-2">
                  <input
                    autoFocus
                    value={newViewName}
                    onChange={e => setNewViewName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleAddView(); if (e.key === 'Escape') setAddingView(false) }}
                    className="input text-sm w-full"
                    placeholder="Nom de la vue..."
                  />
                  <div className="flex gap-2">
                    <button onClick={handleAddView} className="btn-primary btn-sm flex-1">Créer</button>
                    <button onClick={() => setAddingView(false)} className="btn-secondary btn-sm">✕</button>
                  </div>
                </div>
              ) : (
                <button onClick={() => setAddingView(true)}
                  className="flex items-center gap-1.5 text-xs text-indigo-600 hover:text-indigo-800 font-medium w-full">
                  <Plus size={13} /> Nouvelle vue
                </button>
              )}
            </div>
          </div>

          {/* Panneau droit — éditeur */}
          <div className="flex-1 overflow-y-auto p-6">
            {!viewData ? (
              <div className="text-slate-400 text-sm">Chargement...</div>
            ) : (
              <>
                <div className="mb-4">
                  <h3 className="font-semibold text-slate-900 text-sm">
                    {selectedViewId === null
                      ? (TABLE_ALL_LABEL[table] || 'Vue par défaut')
                      : (current.pills.find(p => p.id === selectedViewId)?.label || 'Vue')
                    }
                  </h3>
                  {selectedViewId === null && (
                    <p className="text-xs text-slate-400 mt-0.5">Vue par défaut — colonnes et tri de base pour tous les utilisateurs</p>
                  )}
                </div>
                <ViewConfigEditor
                  key={`${table}-${selectedViewId}`}
                  columns={columns}
                  current={current}
                  selectedViewId={selectedViewId}
                  onSaveGlobal={handleSaveGlobal}
                  onSaveView={handleSaveView}
                  saving={saving}
                />
              </>
            )}
          </div>
        </div>
      </Modal>
    </>
  )
}
