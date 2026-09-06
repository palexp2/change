import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { RefreshCw, ExternalLink, CheckCircle2 } from 'lucide-react'
import api from '../lib/api.js'
import { useListData } from '../lib/useListData.js'
import { ListPage } from '../components/ListPage.jsx'
import { Badge, STRIPE_PAYOUT_STATUS_COLORS as STATUS_COLORS } from '../components/Badge.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'
import DirectDepositsSection from '../components/DirectDepositsSection.jsx'

import { fmtMoney } from '../utils/formatters.js'


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
  const [syncing, setSyncing] = useState(false)
  const [syncError, setSyncError] = useState(null)

  const { rows: payouts, loading, reload: load } = useListData({
    fetch: (page, limit) => api.stripePayouts.list({ limit, page }),
  })

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
    <ListPage
      title="Stripe Payouts"
      subtitle={<p className="text-xs text-slate-500 mt-0.5">Virements Stripe → banque. Pousser vers QuickBooks en tant que Deposit.</p>}
      actions={<>
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
      </>}
      banner={syncError && (
        <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{syncError}</div>
      )}
    >
      <DataTable
        table="stripe_payouts"
        manageViews
        columns={COLUMNS}
        data={payouts}
        loading={loading}
        searchFields={['stripe_id', 'description', 'bank_name', 'qb_deposit_id', 'amount']}
        onRowClick={row => navigate(`/stripe-payouts/${row.stripe_id}`)}
      />

      <DirectDepositsSection />
    </ListPage>
  )
}
