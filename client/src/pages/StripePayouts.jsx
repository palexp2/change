import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { RefreshCw, ExternalLink, CheckCircle2 } from 'lucide-react'
import api from '../lib/api.js'
import { loadProgressive } from '../lib/loadAll.js'
import { Layout } from '../components/Layout.jsx'
import { Badge } from '../components/Badge.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TableConfigModal } from '../components/TableConfigModal.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'

function fmtMoney(n, currency = 'CAD') {
  if (n == null) return '—'
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: (currency || 'CAD').toUpperCase() }).format(n)
}

const STATUS_COLORS = {
  paid:       'green',
  pending:    'yellow',
  in_transit: 'blue',
  canceled:   'gray',
  failed:     'red',
}

const RENDERS = {
  arrival_date: row => <span className="text-slate-500">{fmtDate(row.arrival_date)}</span>,
  stripe_id:    row => <span className="font-mono text-xs text-slate-500">{row.stripe_id}</span>,
  amount:       row => <span className="font-medium text-slate-800 tabular-nums">{fmtMoney(row.amount, row.currency)}</span>,
  currency:     row => <span className="font-mono text-xs text-slate-600">{row.currency}</span>,
  status:       row => row.status
    ? <Badge color={STATUS_COLORS[row.status] || 'gray'}>{row.status}</Badge>
    : <span className="text-slate-400">—</span>,
  method:       row => <span className="text-slate-600">{row.method || '—'}</span>,
  type:         row => <span className="text-slate-600">{row.type || '—'}</span>,
  bank:         row => row.bank_name
    ? <span className="text-slate-600 text-sm">{row.bank_name}{row.bank_last4 ? ` …${row.bank_last4}` : ''}</span>
    : <span className="text-slate-400">—</span>,
  qb_deposit_id: row => row.qb_deposit_id
    ? <span className="inline-flex items-center gap-1 text-xs text-green-700 bg-green-100 px-2 py-0.5 rounded-full"><CheckCircle2 size={10} /> #{row.qb_deposit_id}</span>
    : <span className="text-slate-400">—</span>,
  qb_pushed_at:  row => <span className="text-slate-500">{row.qb_pushed_at ? fmtDate(row.qb_pushed_at) : '—'}</span>,
  description:   row => <span className="text-slate-600">{row.description || '—'}</span>,
  created_date:  row => <span className="text-slate-500">{fmtDate(row.created_date)}</span>,
}

const COLUMNS = TABLE_COLUMN_META.stripe_payouts.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

export default function StripePayouts() {
  const navigate = useNavigate()
  const [payouts, setPayouts] = useState([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [syncError, setSyncError] = useState(null)

  const load = useCallback(async () => {
    await loadProgressive(
      (page, limit) => api.stripePayouts.list({ limit, page }),
      setPayouts, setLoading
    )
  }, [])

  useEffect(() => { load() }, [load])

  async function handleSync() {
    setSyncing(true)
    setSyncError(null)
    try {
      await api.stripePayouts.sync(false)
      await load()
    } catch (e) {
      setSyncError(e.message || 'Erreur de sync')
    } finally {
      setSyncing(false)
    }
  }

  return (
    <Layout>
      <div className="p-6 max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Stripe Payouts</h1>
            <p className="text-xs text-slate-500 mt-0.5">Virements Stripe → banque. Pousser vers QuickBooks en tant que Deposit.</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleSync}
              disabled={syncing}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50"
              title="Synchroniser les nouveaux payouts depuis Stripe"
            >
              <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
              {syncing ? 'Synchronisation…' : 'Sync Stripe'}
            </button>
            <a
              href="https://dashboard.stripe.com/payouts"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50"
            >
              <ExternalLink size={14} /> Stripe
            </a>
            <TableConfigModal table="stripe_payouts" />
          </div>
        </div>

        {syncError && (
          <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{syncError}</div>
        )}

        <DataTable
          table="stripe_payouts"
          columns={COLUMNS}
          data={payouts}
          loading={loading}
          searchFields={['stripe_id', 'description', 'bank_name']}
          onRowClick={row => navigate(`/stripe-payouts/${row.stripe_id}`)}
        />
      </div>
    </Layout>
  )
}
