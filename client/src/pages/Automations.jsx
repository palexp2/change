import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Layout } from '../components/Layout.jsx'
import { Zap, Plus, Lock } from 'lucide-react'
import { useToast } from '../contexts/ToastContext.jsx'
import { api } from '../lib/api.js'
import { DataTable } from '../components/DataTable.jsx'
import { TableConfigModal } from '../components/TableConfigModal.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'

const TRIGGER_LABELS = {
  record_created: 'Record créé',
  record_updated: 'Record modifié',
  field_changed:  'Champ changé',
  field_rule:     'Règle de champ',
  schedule:       'Planifié',
  manual:         'Manuel',
  system:         'Système',
}

const RENDERS = {
  name: row => (
    <div className="flex items-center gap-2">
      <span className="font-medium">{row.name}</span>
      {row.system ? (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-indigo-50 text-indigo-700 border border-indigo-200">
          <Lock size={10} /> Système
        </span>
      ) : null}
    </div>
  ),
  trigger_type: row => <span className="text-slate-600">{TRIGGER_LABELS[row.trigger_type] || row.trigger_type}</span>,
  active: row => (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${
      row.active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
    }`}>
      <span className={`w-1.5 h-1.5 rounded-full ${row.active ? 'bg-green-500' : 'bg-gray-400'}`} />
      {row.active ? 'Actif' : 'Inactif'}
    </span>
  ),
  last_run_at: row => row.last_run_at
    ? <span className="text-slate-500 text-xs">{fmtDate(row.last_run_at)}</span>
    : <span className="text-slate-300">—</span>,
  runs_30d: row => {
    const n = row.runs_30d ?? 0
    return n > 0
      ? <span className="tabular-nums text-slate-700">{n}</span>
      : <span className="text-slate-300">0</span>
  },
  system: row => row.system ? '✓' : '—',
}

const COLUMNS = TABLE_COLUMN_META.automations.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

export function AutomationsContent() {
  const [automations, setAutomations] = useState([])
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()
  const { addToast } = useToast()

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    try {
      const data = await api.automations.list()
      setAutomations(data)
    } catch {
      addToast({ message: 'Erreur de chargement', type: 'error' })
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <Zap size={22} /> Automations
        </h1>
        <div className="flex items-center gap-2">
          <TableConfigModal table="automations" />
          <button onClick={() => navigate('/automations/new?kind=field_rule')}
            className="flex items-center gap-1.5 px-4 py-2 text-sm bg-white border border-indigo-200 text-indigo-700 rounded-lg hover:bg-indigo-50">
            <Zap size={14} /> Nouvelle règle de champ
          </button>
          <button onClick={() => navigate('/automations/new')}
            className="flex items-center gap-1.5 px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">
            <Plus size={14} /> Nouvelle automation
          </button>
        </div>
      </div>

      <DataTable
        table="automations"
        columns={COLUMNS}
        data={automations}
        loading={loading}
        onRowClick={row => navigate(`/automations/${row.id}`)}
        searchFields={['name', 'description']}
      />
    </>
  )
}

export default function Automations() {
  return <Layout><div className="p-6 max-w-7xl mx-auto"><AutomationsContent /></div></Layout>
}
