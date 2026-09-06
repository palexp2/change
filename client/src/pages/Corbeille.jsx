import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Trash2, RotateCcw, ChevronDown, ChevronRight, Clock, Settings2 } from 'lucide-react'
import { useToast } from '../components/ui/ToastProvider.jsx'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { formatRelativeTime } from '../utils/formatters.js'
import api from '../lib/api.js'

const TABLE_ORDER = [
  'custom_fields',
  'companies', 'contacts', 'orders', 'products', 'shipments',
  'returns', 'projects', 'assemblages', 'tasks', 'interactions', 'serial_numbers',
]

const CLEANUP_AUTOMATION_ID = 'sys_trash_auto_cleanup'

// Jours restants avant la suppression définitive automatique. Négatif = déjà
// dû (le nettoyage de la nuit prochaine l'emportera).
function daysLeft(deletedAt, retentionDays) {
  const t = new Date(deletedAt).getTime()
  if (!Number.isFinite(t)) return null
  return Math.ceil((t + retentionDays * 86400000 - Date.now()) / 86400000)
}

function CountdownLabel({ deletedAt, retentionDays, active }) {
  const left = daysLeft(deletedAt, retentionDays)
  if (left === null) return null
  if (!active) return <span className="text-slate-400">· conservé (nettoyage auto en pause)</span>
  if (left <= 0) return <span className="text-red-500">· suppression définitive imminente</span>
  if (left <= 7) return <span className="text-amber-600">· suppression définitive dans {left} j</span>
  return <span className="text-slate-400">· suppression définitive dans {left} j</span>
}

export function CorbeilleContent() {
  const [tables, setTables] = useState({})
  const [retentionDays, setRetentionDays] = useState(30)
  const [autoActive, setAutoActive] = useState(true)
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
      setTables(data.tables || {})
      setRetentionDays(data.retention_days ?? 30)
      setAutoActive(!!data.auto_cleanup_active)
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
    const fieldCount = tables.custom_fields?.items?.length || 0
    if (!(await confirm({
      title: 'Vider la corbeille',
      // Vider détruit pour de bon : un champ perso emporte sa colonne et
      // toutes ses valeurs, et aucun champ ne peut plus revenir.
      message: 'Supprimer définitivement tous les éléments de la corbeille ? Cette action est irréversible.'
        + (fieldCount
          ? ` Les ${fieldCount} champ${fieldCount !== 1 ? 's' : ''} de la corbeille sont détruits pour de bon :`
            + ' un champ personnalisé perd sa colonne et toutes ses valeurs, et aucun champ supprimé ne pourra plus être remis.'
          : ''),
      confirmLabel: 'Vider définitivement',
      danger: true,
    }))) return
    try {
      const res = await api.admin.purgeTrash()
      addToast({
        message: `Corbeille vidée (${res.purged} élément${res.purged !== 1 ? 's' : ''})`
          + (res.blocked ? ` · ${res.blocked} retenu${res.blocked !== 1 ? 's' : ''}` : ''),
        type: res.blocked ? 'warning' : 'success',
      })
      load()
    } catch {
      addToast({ message: 'Erreur lors de la purge', type: 'error' })
    }
  }

  const totalItems = Object.values(tables).reduce((s, t) => s + (t.items?.length || 0), 0)

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
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

      {!loading && (
        <div className="card px-4 py-3 mb-6 flex items-start justify-between gap-4">
          <p className="text-sm text-slate-600 flex items-start gap-2">
            <Clock size={15} className="mt-0.5 shrink-0 text-slate-400" />
            <span>
              {autoActive
                ? <>Les éléments sont supprimés <strong>définitivement</strong> {retentionDays} jours après leur mise à la corbeille.</>
                : <>Le nettoyage automatique est <strong>en pause</strong> : rien n'est supprimé définitivement sans action manuelle.</>}
              {' '}Les champs supprimés, eux, attendent ici un vidage manuel : les détruire supprime la colonne
              et les valeurs d'un champ personnalisé, et interdit définitivement le retour du champ — le nettoyage
              automatique ne prend pas cette décision tout seul.
            </span>
          </p>
          <Link
            to={`/automations/${CLEANUP_AUTOMATION_ID}`}
            className="shrink-0 flex items-center gap-1.5 text-xs text-brand-600 hover:text-brand-800 font-medium px-2.5 py-1.5 rounded hover:bg-brand-50 transition-colors"
          >
            <Settings2 size={13} /> Régler
          </Link>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" /></div>
      ) : totalItems === 0 ? (
        <div className="text-center py-16 text-slate-400">
          <Trash2 size={32} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">La corbeille est vide</p>
        </div>
      ) : (
        <div className="space-y-2">
          {TABLE_ORDER.map(key => {
            const section = tables[key]
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
                          <p className="text-xs text-slate-400">
                            Supprimé {formatRelativeTime(item.deleted_at)}{' '}
                            {section.auto_purge
                              ? <CountdownLabel deletedAt={item.deleted_at} retentionDays={retentionDays} active={autoActive} />
                              : <span className="text-slate-400">· conservé jusqu'à un vidage manuel</span>}
                          </p>
                        </div>
                        <button
                          onClick={() => handleRestore(key, item.id)}
                          className="flex items-center gap-1.5 text-xs text-brand-600 hover:text-brand-800 font-medium px-2.5 py-1.5 rounded hover:bg-brand-50 transition-colors"
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
