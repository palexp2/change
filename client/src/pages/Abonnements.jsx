import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { ExternalLink, RefreshCw, CreditCard } from 'lucide-react'
import api from '../lib/api.js'
import { loadProgressive } from '../lib/loadAll.js'
import { Layout } from '../components/Layout.jsx'
import { Badge } from '../components/Badge.jsx'
import { AbonnementDetailModal } from '../components/AbonnementDetailModal.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TableConfigModal } from '../components/TableConfigModal.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'
import { useToast } from '../contexts/ToastContext.jsx'

function fmtCad(n) {
  if (!n && n !== 0) return '—'
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD' }).format(n)
}


const STATUS_COLORS = {
  // Stripe (anglais)
  'active': 'green',
  'trialing': 'blue',
  'past_due': 'yellow',
  'canceled': 'red',
  // Airtable (français)
  'Actif': 'green',
  'Inactif': 'gray',
  'Suspendu': 'yellow',
  'Annulé': 'red',
  'Expiré': 'orange',
}

const RACHAT_COLORS = {
  'rachat complet':  'bg-green-100 text-green-700',
  'rachat partiel':  'bg-yellow-100 text-yellow-700',
  'fusion':          'bg-purple-100 text-purple-700',
  'non':             'bg-slate-100 text-slate-600',
}

function RachatCell({ row, onChange }) {
  const { addToast } = useToast()
  const [saving, setSaving] = useState(false)

  async function handleChange(e) {
    e.stopPropagation()
    const val = e.target.value || null
    setSaving(true)
    try {
      await api.abonnements.patch(row.id, { rachat: val })
      onChange(row.id, val)
    } catch (err) {
      addToast({ message: err.message, type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="relative inline-block" onClick={e => e.stopPropagation()}>
      <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full pointer-events-none select-none ${
        row.rachat ? RACHAT_COLORS[row.rachat] : 'text-slate-300'
      } ${saving ? 'opacity-50' : ''}`}>
        {row.rachat || '+ ajouter'}
      </span>
      <select
        value={row.rachat || ''}
        onChange={handleChange}
        disabled={saving}
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
      >
        <option value="">— aucun</option>
        <option value="rachat complet">Rachat complet</option>
        <option value="rachat partiel">Rachat partiel</option>
        <option value="fusion">Fusion</option>
        <option value="non">Non</option>
      </select>
    </div>
  )
}

const RENDERS = {
  company_name: row => row.company_id
    ? <Link to={`/companies/${row.company_id}`} onClick={e => e.stopPropagation()} className="text-indigo-600 hover:underline">{row.company_name}</Link>
    : <span className="text-slate-400">—</span>,
  status:     row => row.status
    ? <Badge color={STATUS_COLORS[row.status] || 'gray'}>{row.status}</Badge>
    : <span className="text-slate-400">—</span>,
  amount_cad: row => <span className="font-medium text-slate-700">{fmtCad(row.amount_cad)}</span>,
  start_date: row => <span className="text-slate-500">{fmtDate(row.start_date)}</span>,
  end_date:   row => <span className="text-slate-500">{fmtDate(row.end_date)}</span>,
  stripe_url: row => row.stripe_url
    ? <a href={row.stripe_url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} className="inline-flex items-center gap-1 text-purple-600 hover:underline text-xs"><ExternalLink size={12} /> Stripe</a>
    : <span className="text-slate-400">—</span>,
}


export default function Abonnements() {
  const { addToast } = useToast()
  const [abonnements, setAbonnements] = useState([])
  const [loading, setLoading] = useState(true)
  const [stripeConfigured, setStripeConfigured] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [selected, setSelected] = useState(null)

  function handleRachatChange(id, val) {
    setAbonnements(prev => prev.map(a => a.id === id ? { ...a, rachat: val } : a))
  }

  const COLUMNS = TABLE_COLUMN_META.abonnements.map(meta => ({
    ...meta,
    render: meta.id === 'rachat'
      ? row => <RachatCell row={row} onChange={handleRachatChange} />
      : RENDERS[meta.id],
  }))

  const load = useCallback(async () => {
    api.stripe.info().catch(() => ({ configured: false })).then(info => setStripeConfigured(!!info.configured))
    await loadProgressive(
      (page, limit) => api.abonnements.list({ limit, page }),
      setAbonnements, setLoading
    )
  }, [])

  useEffect(() => { load() }, [load])

  const syncStripe = async () => {
    setSyncing(true)
    try {
      await api.stripe.sync()
      // Poll until sync finishes, then reload
      const poll = setInterval(async () => {
        try {
          const status = await api.connectors.syncStatus()
          if (!status?.stripe?.running) {
            clearInterval(poll)
            await load()
            setSyncing(false)
          }
        } catch { clearInterval(poll); setSyncing(false) }
      }, 1500)
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
      setSyncing(false)
    }
  }

  return (
    <Layout>
      <div className="p-6 max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Abonnements</h1>
          </div>
          <div className="flex items-center gap-2">
            {stripeConfigured && (
              <button onClick={syncStripe} disabled={syncing} className="btn-secondary btn-sm text-xs">
                <RefreshCw size={12} className={syncing ? 'animate-spin' : ''} />
                {syncing ? 'Synchronisation…' : 'Sync Stripe'}
              </button>
            )}
            <TableConfigModal table="abonnements" />
          </div>
        </div>

        {!loading && !stripeConfigured && (
          <div className="mb-4 flex items-center gap-3 px-4 py-3 bg-purple-50 border border-purple-200 rounded-xl text-sm text-purple-800">
            <CreditCard size={16} className="text-purple-500 flex-shrink-0" />
            <span>Configurez le connecteur Stripe pour synchroniser les abonnements en temps réel.</span>
            <Link to="/connectors" className="ml-auto text-xs font-semibold text-purple-700 hover:underline whitespace-nowrap">
              Configurer →
            </Link>
          </div>
        )}

        <DataTable
          table="abonnements"
          columns={COLUMNS}
          data={abonnements}
          loading={loading}
          searchFields={['company_name']}
          onRowClick={setSelected}
        />
      </div>

      <AbonnementDetailModal abonnement={selected} onClose={() => setSelected(null)} />
    </Layout>
  )
}
