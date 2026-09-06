import { useState, useEffect } from 'react'
import { Plus, X, Pencil, Check, Lock, Unlock } from 'lucide-react'
import { useAuth } from '../lib/auth.jsx'
import api from '../lib/api.js'
import { TABLE_LABELS } from '../lib/tableDefs.js'
import { Modal } from './Modal.jsx'
import { useConfirm } from './ConfirmProvider.jsx'
import Spinner from './Spinner.jsx'

export function TableConfigModal({ table, bulkDelete = false }) {
  const { user } = useAuth()
  const confirm = useConfirm()
  const [open, setOpen]               = useState(false)
  const [pills, setPills]             = useState([])
  const [loading, setLoading]         = useState(false)
  const [addingView, setAddingView]   = useState(false)
  const [newViewName, setNewViewName] = useState('')
  const [editingId, setEditingId]     = useState(null)
  const [editingName, setEditingName] = useState('')
  const [bulkDeleteEnabled, setBulkDeleteEnabled] = useState(false)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setEditingId(null)
    setAddingView(false)
    setNewViewName('')
    api.views.get(table)
      .then(data => {
        setPills(data.pills || [])
        setBulkDeleteEnabled(data.config?.bulk_delete_enabled === true)
      })
      .catch(() => setPills([]))
      .finally(() => setLoading(false))
  }, [open, table])

  async function toggleBulkDelete() {
    const next = !bulkDeleteEnabled
    setBulkDeleteEnabled(next)
    try {
      await api.views.setBulkDeleteEnabled(table, next)
      window.dispatchEvent(new CustomEvent('views:updated', { detail: { table } }))
    } catch {
      setBulkDeleteEnabled(!next)
    }
  }

  if (user?.role !== 'admin') return null

  async function handleAddView() {
    const name = newViewName.trim()
    if (!name) return
    const pill = await api.views.createPill(table, {
      label: name,
      color: 'blue',
      filters: [],
      visible_columns: [],
      sort: [],
      group_by: null,
      sort_order: pills.length,
    })
    setPills(p => [...p, pill])
    setNewViewName('')
    setAddingView(false)
    window.dispatchEvent(new CustomEvent('views:updated', { detail: { table } }))
    setOpen(false)
  }

  async function handleRename(id) {
    const name = editingName.trim()
    if (!name) { setEditingId(null); return }
    const updated = await api.views.updatePill(table, id, { label: name })
    setPills(p => p.map(x => x.id === id ? updated : x))
    setEditingId(null)
    window.dispatchEvent(new CustomEvent('views:updated', { detail: { table } }))
  }

  async function handleDeleteView(id) {
    if (!(await confirm('Supprimer cette vue ?'))) return
    await api.views.deletePill(table, id)
    setPills(p => p.filter(x => x.id !== id))
    window.dispatchEvent(new CustomEvent('views:updated', { detail: { table } }))
  }

  async function handleToggleLock(pill) {
    const updated = await api.views.setPillLocked(table, pill.id, !pill.locked)
    setPills(p => p.map(x => x.id === pill.id ? updated : x))
    window.dispatchEvent(new CustomEvent('views:updated', { detail: { table } }))
  }

  function startEdit(pill) {
    setEditingId(pill.id)
    setEditingName(pill.label)
  }

  return (
    <>
      {/* Crayon sur la barre des vues (remplace l'ancienne roue dentelée en haut de page) */}
      <button
        onClick={() => setOpen(true)}
        className="self-center p-1.5 mx-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded transition-colors flex-shrink-0"
        title="Gérer les vues"
      >
        <Pencil size={14} />
      </button>

      <Modal
        isOpen={open}
        onClose={() => setOpen(false)}
        title={`Vues — ${TABLE_LABELS[table] || table}`}
        size="md"
      >
        <div className="space-y-3">
          {loading ? (
            <div className="text-slate-400 text-sm py-4"><Spinner size="xs" label="Chargement…" /></div>
          ) : (
            <>
              <div className="space-y-1">
                {pills.length === 0 && (
                  <p className="text-sm text-slate-400 py-2">Aucune vue personnalisée.</p>
                )}
                {pills.map(pill => (
                  <div key={pill.id} className="group flex items-center gap-2 px-2 py-1.5 rounded hover:bg-slate-50">
                    {editingId === pill.id ? (
                      <>
                        <input
                          autoFocus
                          value={editingName}
                          onChange={e => setEditingName(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter') handleRename(pill.id)
                            if (e.key === 'Escape') setEditingId(null)
                          }}
                          className="input text-sm flex-1"
                        />
                        <button onClick={() => handleRename(pill.id)} className="p-1 text-brand-600 hover:text-brand-800">
                          <Check size={15} />
                        </button>
                        <button onClick={() => setEditingId(null)} className="p-1 text-slate-400 hover:text-slate-600">
                          <X size={15} />
                        </button>
                      </>
                    ) : (
                      <>
                        <span className="flex-1 text-sm text-slate-700 truncate flex items-center gap-1.5">
                          {pill.locked && <Lock size={12} className="text-amber-600 flex-shrink-0" />}
                          {pill.label}
                        </span>
                        <button
                          onClick={() => handleToggleLock(pill)}
                          className={`p-1 transition-opacity ${pill.locked ? 'text-amber-600 opacity-100 hover:text-amber-700' : 'opacity-0 group-hover:opacity-100 text-slate-400 hover:text-slate-700'}`}
                          title={pill.locked ? 'Déverrouiller (rendre modifiable)' : 'Verrouiller en lecture seule'}
                        >
                          {pill.locked ? <Lock size={14} /> : <Unlock size={14} />}
                        </button>
                        {!pill.locked && (
                          <>
                            <button
                              onClick={() => startEdit(pill)}
                              className="opacity-0 group-hover:opacity-100 p-1 text-slate-400 hover:text-slate-700 transition-opacity"
                              title="Renommer"
                            >
                              <Pencil size={13} />
                            </button>
                            <button
                              onClick={() => handleDeleteView(pill.id)}
                              className="opacity-0 group-hover:opacity-100 p-1 text-slate-300 hover:text-red-500 transition-opacity"
                              title="Supprimer"
                            >
                              <X size={15} />
                            </button>
                          </>
                        )}
                      </>
                    )}
                  </div>
                ))}
              </div>

              {bulkDelete && (
                <div className="border-t border-slate-200 pt-3">
                  <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={bulkDeleteEnabled}
                      onChange={toggleBulkDelete}
                      className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                    />
                    Autoriser la suppression en lot
                  </label>
                  <p className="text-xs text-slate-400 mt-1 ml-6">Quand activé, des cases à cocher apparaissent sur chaque ligne et un bouton permet de supprimer plusieurs enregistrements à la fois.</p>
                </div>
              )}

              <div className="border-t border-slate-200 pt-3">
                {addingView ? (
                  <div className="flex items-center gap-2">
                    <input
                      autoFocus
                      value={newViewName}
                      onChange={e => setNewViewName(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') handleAddView()
                        if (e.key === 'Escape') { setAddingView(false); setNewViewName('') }
                      }}
                      className="input text-sm flex-1"
                    />
                    <button onClick={handleAddView} className="btn-primary btn-sm">Créer</button>
                    <button onClick={() => { setAddingView(false); setNewViewName('') }} className="btn-secondary btn-sm">
                      <X size={14} />
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setAddingView(true)}
                    className="flex items-center gap-1.5 text-xs text-brand-600 hover:text-brand-800 font-medium"
                  >
                    <Plus size={13} /> Nouvelle vue
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </Modal>
    </>
  )
}
