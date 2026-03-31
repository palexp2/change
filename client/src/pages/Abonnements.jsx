import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { ExternalLink, RefreshCw, CreditCard } from 'lucide-react'
import api from '../lib/api.js'
import { loadProgressive } from '../lib/loadAll.js'
import { Layout } from '../components/Layout.jsx'
import { Badge } from '../components/Badge.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TableConfigModal } from '../components/TableConfigModal.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'

function fmtCad(n) {
  if (!n && n !== 0) return '—'
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD' }).format(n)
}

function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('fr-CA', { month: 'short', day: 'numeric', year: 'numeric' })
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

const RENDERS = {
  company_name: row => row.company_id
    ? <Link to={`/companies/${row.company_id}`} onClick={e => e.stopPropagation()} className="text-indigo-600 hover:underline">{row.company_name}</Link>
    : <span className="text-slate-400">—</span>,
  type:       row => <span className="text-slate-700">{row.type || '—'}</span>,
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

const COLUMNS = TABLE_COLUMN_META.abonnements.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

export default function Abonnements() {
  const [abonnements, setAbonnements] = useState([])
  const [loading, setLoading] = useState(true)
  const [stripeConfigured, setStripeConfigured] = useState(false)
  const [syncing, setSyncing] = useState(false)

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
      alert(e.message)
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
          searchFields={['company_name', 'type']}
        />
      </div>
    </Layout>
  )
}
