import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Layout } from '../components/Layout.jsx'
import { Zap, Plus, Lock, Webhook } from 'lucide-react'
import { useToast } from '../contexts/ToastContext.jsx'
import { api } from '../lib/api.js'
import { DataTable } from '../components/DataTable.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDateTime } from '../lib/formatDate.js'

const TRIGGER_LABELS = {
  record_created: 'Record créé',
  record_updated: 'Record modifié',
  field_changed:  'Champ changé',
  field_rule:     'Règle de champ',
  webhook:        'Webhook',
  schedule:       'Planifié',
  manual:         'Manuel',
  system:         'Système',
}

const OP_SYMBOLS = { eq: '=', ne: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤', in: '∈', not_null: 'renseigné' }
import { AUTOMATION_ACTION_LABELS as ACTION_LABELS } from '../components/Badge.jsx'

// Human-readable "condition → action" summary, so every trigger is consultable
// at a glance from the list (e.g. orders.nombre_d_items > 1 → Script).
function triggerSummary(row) {
  if (row.kind !== 'field_rule') return null
  let tc = {}
  try { tc = JSON.parse(row.trigger_config || '{}') } catch { return null }
  if (!tc.erp_table || !tc.column) return null
  const sym = OP_SYMBOLS[tc.op || 'eq'] || tc.op
  const val = tc.op === 'not_null'
    ? ''
    : ` ${Array.isArray(tc.value) ? tc.value.join(', ') : (tc.value ?? '')}`
  const cond = tc.op === 'not_null'
    ? `${tc.erp_table}.${tc.column} ${sym}`
    : `${tc.erp_table}.${tc.column} ${sym}${val}`
  return { cond, action: ACTION_LABELS[row.action_type] || row.action_type }
}

const RENDERS = {
  name: row => (
    <div className="flex items-center gap-2">
      <span className="font-medium">{row.name}</span>
      {row.system ? (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-brand-50 text-brand-700 border border-brand-200">
          <Lock size={10} /> Système
        </span>
      ) : null}
    </div>
  ),
  trigger_type: row => <span className="text-slate-600">{TRIGGER_LABELS[row.trigger_type] || row.trigger_type}</span>,
  summary: row => {
    const s = triggerSummary(row)
    if (!s) return <span className="text-slate-300">—</span>
    return (
      <span className="inline-flex items-center gap-1.5 text-xs">
        <code className="bg-gray-100 text-gray-700 px-1.5 py-0.5 rounded font-mono">{s.cond}</code>
        <span className="text-slate-400">→</span>
        <span className="font-medium text-brand-700">{s.action}</span>
      </span>
    )
  },
  active: row => (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${
      row.active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
    }`}>
      <span className={`w-1.5 h-1.5 rounded-full ${row.active ? 'bg-green-500' : 'bg-gray-400'}`} />
      {row.active ? 'Actif' : 'Inactif'}
    </span>
  ),
  last_run_at: row => row.last_run_at
    ? <span className="text-slate-500 text-xs">{fmtDateTime(row.last_run_at)}</span>
    : <span className="text-slate-300">—</span>,
  runs_30d: row => {
    const n = row.runs_30d ?? 0
    return n > 0
      ? <span className="tabular-nums text-slate-700">{n}</span>
      : <span className="text-slate-300">0</span>
  },
  // Taux d'échec passif sur 30j, lu depuis automation_logs (status='error').
  // Badge rouge si ≥1 échec, point vert discret si tout passe, tiret si aucun run.
  health: row => {
    const errors = row.errors_30d ?? 0
    const runs = row.runs_30d ?? 0
    if (errors > 0) {
      const rate = runs > 0 ? Math.round((errors / runs) * 100) : 100
      return (
        <span
          className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700"
          title={`${errors} échec${errors > 1 ? 's' : ''} sur ${runs} run${runs > 1 ? 's' : ''} (${rate}%) — 30 derniers jours`}
        >
          <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
          {errors} échec{errors > 1 ? 's' : ''} / 30j
        </span>
      )
    }
    if (runs > 0) {
      return (
        <span className="inline-flex items-center gap-1.5 text-xs text-green-600" title={`${runs} run${runs > 1 ? 's' : ''} sans échec — 30 derniers jours`}>
          <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
          OK
        </span>
      )
    }
    return <span className="text-slate-300">—</span>
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
          <button onClick={() => navigate('/automations/new?kind=field_rule')}
            className="flex items-center gap-1.5 px-4 py-2 text-sm bg-white border border-brand-200 text-brand-700 rounded-lg hover:bg-brand-50">
            <Zap size={14} /> Nouvelle règle de champ
          </button>
          <button onClick={() => navigate('/automations/new?kind=webhook')}
            className="flex items-center gap-1.5 px-4 py-2 text-sm bg-white border border-brand-200 text-brand-700 rounded-lg hover:bg-brand-50">
            <Webhook size={14} /> Nouveau webhook
          </button>
          <button onClick={() => navigate('/automations/new')}
            className="flex items-center gap-1.5 px-4 py-2 text-sm bg-brand-600 text-white rounded-lg hover:bg-brand-700">
            <Plus size={14} /> Nouvelle automation
          </button>
        </div>
      </div>

      <DataTable
        table="automations"
        manageViews
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
  return <Layout><div className="p-6"><AutomationsContent /></div></Layout>
}
