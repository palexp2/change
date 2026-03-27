import { useState, useEffect } from 'react'
import { Layout } from '../components/Layout.jsx'
import { Trash2, LayoutGrid } from 'lucide-react'
import { useToast } from '../components/ui/ToastProvider.jsx'
import { baseAPI } from '../hooks/useBaseAPI.js'
import { DynamicIcon } from '../components/ui/DynamicIcon.jsx'
import { formatRelativeTime } from '../utils/formatters.js'

const FIELD_TYPE_ICONS = {
  text: 'Type', number: 'Hash', select: 'List', multiselect: 'ListChecks',
  date: 'Calendar', checkbox: 'CheckSquare', link: 'Link2', formula: 'Function',
  rollup: 'Sigma', lookup: 'Search', file: 'Paperclip', email: 'Mail',
  phone: 'Phone', url: 'Globe', currency: 'DollarSign', autonumber: 'Hash',
}

export function CorbeilleContent() {
  const [activeTab, setActiveTab] = useState('tables')
  const [trash, setTrash] = useState({ tables: [], fields: [], views: [] })
  const [loading, setLoading] = useState(true)
  const { addToast } = useToast()

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    try {
      const res = await baseAPI.trash()
      setTrash({
        tables: res.tables || [],
        fields: res.fields || [],
        views:  res.views  || [],
      })
    } catch {
      addToast({ message: 'Erreur de chargement', type: 'error' })
    } finally {
      setLoading(false)
    }
  }

  async function handleRestore(type, id) {
    try {
      if (type === 'table') await baseAPI.restoreTable(id)
      else if (type === 'field') {
        const token = localStorage.getItem('erp_token')
        await fetch(`/erp/api/base/fields/${id}/restore`, {
          method: 'POST', headers: { 'Authorization': `Bearer ${token}` }
        })
      } else if (type === 'view') {
        const token = localStorage.getItem('erp_token')
        await fetch(`/erp/api/base/views/${id}/restore`, {
          method: 'POST', headers: { 'Authorization': `Bearer ${token}` }
        })
      }
      addToast({ message: 'Élément restauré', type: 'success' })
      load()
    } catch {
      addToast({ message: 'Erreur lors de la restauration', type: 'error' })
    }
  }

  async function handlePurge() {
    if (!confirm('Vider la corbeille ? Cette action est irréversible.')) return
    try {
      const res = await baseAPI.purgeTrash()
      const p = res.purged || {}
      addToast({ message: `Corbeille vidée (${p.tables || 0} tables, ${p.fields || 0} champs, ${p.views || 0} vues)`, type: 'success' })
      load()
    } catch {
      addToast({ message: 'Erreur lors de la purge', type: 'error' })
    }
  }

  const totalItems = trash.tables.length + trash.fields.length + trash.views.length

  const tabs = [
    { key: 'tables', label: 'Tables', count: trash.tables.length },
    { key: 'fields', label: 'Champs', count: trash.fields.length },
    { key: 'views',  label: 'Vues',   count: trash.views.length },
  ]

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <Trash2 size={22} /> Corbeille
          </h2>
          <p className="text-sm text-gray-500 mt-1">Les éléments sont conservés 30 jours avant suppression définitive.</p>
        </div>
        {totalItems > 0 && (
          <button onClick={handlePurge}
            className="px-4 py-2 text-sm text-red-600 border border-red-200 rounded-lg hover:bg-red-50">
            Vider la corbeille
          </button>
        )}
      </div>

        <div className="flex gap-1 mb-4 border-b">
          {tabs.map(tab => (
            <button key={tab.key} onClick={() => setActiveTab(tab.key)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 ${
                activeTab === tab.key ? 'border-indigo-500 text-indigo-600' : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}>
              {tab.label}
              {tab.count > 0 && (
                <span className="ml-1.5 text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded-full">{tab.count}</span>
              )}
            </button>
          ))}
        </div>

        {activeTab === 'tables' && (
          <TrashList items={trash.tables} emptyMessage="Aucune table dans la corbeille"
            renderItem={t => (
              <TrashItem key={t.id}
                icon={<DynamicIcon name={t.icon || 'Table2'} size={16} className="text-gray-400" />}
                name={t.name}
                meta={`${t.record_count || 0} enregistrements`}
                deletedAt={t.deleted_at}
                onRestore={() => handleRestore('table', t.id)}
              />
            )}
          />
        )}
        {activeTab === 'fields' && (
          <TrashList items={trash.fields} emptyMessage="Aucun champ dans la corbeille"
            renderItem={f => (
              <TrashItem key={f.id}
                icon={<DynamicIcon name={FIELD_TYPE_ICONS[f.type] || 'Type'} size={16} className="text-gray-400" />}
                name={f.name}
                meta={`Table : ${f.table_name || '—'}`}
                deletedAt={f.deleted_at}
                onRestore={() => handleRestore('field', f.id)}
              />
            )}
          />
        )}
        {activeTab === 'views' && (
          <TrashList items={trash.views} emptyMessage="Aucune vue dans la corbeille"
            renderItem={v => (
              <TrashItem key={v.id}
                icon={<LayoutGrid size={16} className="text-gray-400" />}
                name={v.name}
                meta={`Table : ${v.table_name || '—'}`}
                deletedAt={v.deleted_at}
                onRestore={() => handleRestore('view', v.id)}
              />
            )}
          />
        )}
    </div>
  )
}

export default function Corbeille() {
  return <Layout><div className="p-6 max-w-4xl mx-auto"><CorbeilleContent /></div></Layout>
}

function TrashList({ items, emptyMessage, renderItem }) {
  if (items.length === 0) {
    return <div className="text-center py-12 text-sm text-gray-400">{emptyMessage}</div>
  }
  return <div className="bg-white rounded-lg border divide-y">{items.map(renderItem)}</div>
}

function TrashItem({ icon, name, meta, deletedAt, onRestore }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50">
      {icon}
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-gray-700 truncate">{name}</div>
        <div className="text-xs text-gray-400">{meta}</div>
      </div>
      <span className="text-xs text-gray-400 shrink-0">Supprimé {formatRelativeTime(deletedAt)}</span>
      <button onClick={onRestore}
        className="text-sm text-indigo-600 hover:text-indigo-700 font-medium shrink-0 ml-2">
        Restaurer
      </button>
    </div>
  )
}
