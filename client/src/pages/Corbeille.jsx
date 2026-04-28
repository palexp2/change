import { useState, useEffect } from 'react'
import { Layout } from '../components/Layout.jsx'
import { Trash2, RotateCcw, ChevronDown, ChevronRight } from 'lucide-react'
import { useToast } from '../components/ui/ToastProvider.jsx'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { formatRelativeTime } from '../utils/formatters.js'
import api from '../lib/api.js'

const TABLE_ORDER = [
  'companies', 'contacts', 'orders', 'products', 'shipments',
  'returns', 'projects', 'assemblages', 'tasks', 'interactions', 'serial_numbers',
]

export function CorbeilleContent() {
  const [trash, setTrash] = useState({})
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState({})
  const { addToast } = useToast()
  const confirm = useConfirm()

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    try {
      const data = await api.admin.trash()
      setTrash(data)
    } catch {
      addToast({ message: 'Erreur de chargement', type: 'error' })
    } finally {
      setLoading(false)
    }
  }

  async function handleRestore(table, id) {
    try {
      await api.admin.restoreTrash(table, id)
      addToast({ message: 'Élément restauré', type: 'success' })
      load()
    } catch {
      addToast({ message: 'Erreur lors de la restauration', type: 'error' })
    }
  }

  async function handlePurge() {
    if (!(await confirm('Supprimer définitivement tous les éléments de la corbeille ? Cette action est irréversible.'))) return
    try {
      const res = await api.admin.purgeTrash()
      addToast({ message: `Corbeille vidée (${res.purged} élément${res.purged !== 1 ? 's' : ''})`, type: 'success' })
      load()
    } catch {
      addToast({ message: 'Erreur lors de la purge', type: 'error' })
    }
  }

  const totalItems = Object.values(trash).reduce((s, t) => s + (t.items?.length || 0), 0)

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <Trash2 size={20} /> Corbeille
          </h2>
          <p className="text-sm text-slate-500 mt-0.5">
            {loading ? 'Chargement…' : totalItems === 0 ? 'Aucun élément supprimé' : `${totalItems} élément${totalItems !== 1 ? 's' : ''} supprimé${totalItems !== 1 ? 's' : ''}`}
          </p>
        </div>
        {totalItems > 0 && (
          <button onClick={handlePurge} className="px-4 py-2 text-sm text-red-600 border border-red-200 rounded-lg hover:bg-red-50 transition-colors">
            Vider la corbeille
          </button>
        )}
      </div>

      {loading ? (
        <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" /></div>
      ) : totalItems === 0 ? (
        <div className="text-center py-16 text-slate-400">
          <Trash2 size={32} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">La corbeille est vide</p>
        </div>
      ) : (
        <div className="space-y-2">
          {TABLE_ORDER.map(key => {
            const section = trash[key]
            if (!section || section.items.length === 0) return null
            const isOpen = expanded[key] !== false // open by default
            return (
              <div key={key} className="card overflow-hidden">
                <button
                  onClick={() => setExpanded(e => ({ ...e, [key]: !isOpen }))}
                  className="w-full flex items-center justify-between px-4 py-3 hover:bg-slate-50 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    {isOpen ? <ChevronDown size={14} className="text-slate-400" /> : <ChevronRight size={14} className="text-slate-400" />}
                    <span className="text-sm font-medium text-slate-700">{section.label}</span>
                    <span className="text-xs bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded-full">{section.items.length}</span>
                  </div>
                </button>
                {isOpen && (
                  <div className="divide-y divide-slate-100 border-t border-slate-100">
                    {section.items.map(item => (
                      <div key={item.id} className="flex items-center justify-between px-4 py-2.5 hover:bg-slate-50">
                        <div>
                          <p className="text-sm text-slate-800">{item.label || item.id}</p>
                          <p className="text-xs text-slate-400">Supprimé {formatRelativeTime(item.deleted_at)}</p>
                        </div>
                        <button
                          onClick={() => handleRestore(key, item.id)}
                          className="flex items-center gap-1.5 text-xs text-indigo-600 hover:text-indigo-800 font-medium px-2.5 py-1.5 rounded hover:bg-indigo-50 transition-colors"
                        >
                          <RotateCcw size={12} /> Restaurer
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default function Corbeille() {
  return <Layout><div className="p-6 max-w-4xl mx-auto"><CorbeilleContent /></div></Layout>
}
