// Historique des opérations d'un compte du plan comptable (grand livre QB),
// ouvert en panneau latéral depuis /plan-comptable. Clic sur une ligne →
// l'opération dans QuickBooks.
import { useEffect, useState } from 'react'
import { BookOpen } from 'lucide-react'
import api from '../lib/api.js'
import { DataTable } from '../components/DataTable.jsx'
import ErrorBanner from '../components/ErrorBanner.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtMoney } from '../utils/formatters.js'

const monthsAgo = n => {
  const d = new Date()
  d.setMonth(d.getMonth() - n)
  return d.toISOString().slice(0, 10)
}
const PERIODS = [
  { key: '3m', label: '3 mois', since: () => monthsAgo(3) },
  { key: '12m', label: '12 mois', since: () => monthsAgo(12) },
  { key: 'all', label: 'Tout', since: () => '2000-01-01' },
]

export default function QbAccountLedger({ account }) {
  const [period, setPeriod] = useState('12m')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let live = true
    setLoading(true)
    setError(null)
    api.quickbooks.accountLedger(account.id, PERIODS.find(p => p.key === period).since())
      .then(d => { if (live) setData(d) })
      .catch(e => { if (live) { setError(e.message || 'QuickBooks injoignable'); setData(null) } })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [account.id, period])

  const cur = data?.currency || account.currency
  const money = v => v ? <span className="tabular-nums">{fmtMoney(v, cur)}</span> : null
  const renders = {
    debit: row => money(row.debit),
    credit: row => money(row.credit),
    balance: row => <span className="tabular-nums text-slate-800">{fmtMoney(row.balance, cur)}</span>,
  }
  const columns = TABLE_COLUMN_META.qb_account_ledger.map(meta => ({ ...meta, render: renders[meta.id] }))

  return (
    <div className="px-5 py-4" data-testid="qb-account-ledger">
      {error && <ErrorBanner className="mb-3">{error}</ErrorBanner>}
      <DataTable
        table="qb_account_ledger"
        columns={columns}
        data={data?.rows || []}
        loading={loading}
        searchFields={['type', 'doc_num', 'name', 'memo', 'split', 'sub_account']}
        onRowClick={row => { if (row.url) window.open(row.url, '_blank', 'noopener') }}
        emptyState={{ icon: BookOpen, title: 'Aucune opération' }}
        toolbarEnd={
          <div className="ml-2 inline-flex rounded-md border border-slate-200 overflow-hidden text-xs">
            {PERIODS.map(p => (
              <button key={p.key} type="button" onClick={() => setPeriod(p.key)}
                className={`px-2.5 h-7 ${period === p.key ? 'bg-slate-100 text-slate-800 font-medium' : 'text-slate-600 hover:bg-slate-50'}`}>
                {p.label}
              </button>
            ))}
          </div>
        }
      />
    </div>
  )
}
