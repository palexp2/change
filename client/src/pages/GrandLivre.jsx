// Grand livre Boréal ↔ QuickBooks : pour chaque fin de mois, la balance de
// vérification calculée par Boréal à côté de celle de QBO (sys_gl_reconciliation).
// Clic sur un mois → comptes comparés ; clic sur un compte → ses lignes du mois,
// chacune ouvrant la transaction dans QBO.
import { useCallback, useEffect, useState } from 'react'
import { Scale, RefreshCw } from 'lucide-react'
import api from '../lib/api.js'
import { ListPage } from '../components/ListPage.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { Badge } from '../components/Badge.jsx'
import ErrorBanner from '../components/ErrorBanner.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtMoney } from '../utils/formatters.js'
import { fmtDateTime } from '../lib/formatDate.js'

const monthLabel = ym => {
  const [y, m] = ym.split('-').map(Number)
  return new Date(y, m - 1, 1).toLocaleDateString('fr-CA', { month: 'long', year: 'numeric' })
}
const money = v => <span className="tabular-nums">{fmtMoney(v, 'CAD')}</span>

function StatusBadge({ row }) {
  if (row.error && !row.accounts) return <Badge color="gray"><span title={row.error}>Erreur</span></Badge>
  if (!row.mismatches) return <Badge color="green">Identique</Badge>
  return <Badge color="red">{row.mismatches} compte{row.mismatches > 1 ? 's' : ''} diffère{row.mismatches > 1 ? 'nt' : ''}</Badge>
}

const MONTH_RENDERS = {
  month: row => <span className="capitalize text-slate-800">{monthLabel(row.month)}</span>,
  status: row => <StatusBadge row={row} />,
  total_diff: row => row.total_diff ? <span className="tabular-nums text-red-700">{fmtMoney(row.total_diff, 'CAD')}</span> : null,
  checked_at: row => <span className="text-slate-500">{fmtDateTime(row.checked_at)}</span>,
}
const MONTH_COLUMNS = TABLE_COLUMN_META.gl_recon_months.map(m => ({ ...m, render: MONTH_RENDERS[m.id] }))

const ACCOUNT_RENDERS = {
  boreal_balance: row => money(row.boreal_balance),
  qbo_balance: row => money(row.qbo_balance),
  diff: row => row.diff ? <span className="tabular-nums font-medium text-red-700">{fmtMoney(row.diff, 'CAD')}</span> : <span className="text-green-600">✓</span>,
}
const ACCOUNT_COLUMNS = TABLE_COLUMN_META.gl_recon_accounts.map(m => ({ ...m, render: ACCOUNT_RENDERS[m.id] }))

const LINE_RENDERS = {
  debit: row => row.debit ? money(row.debit) : null,
  credit: row => row.credit ? money(row.credit) : null,
}
const LINE_COLUMNS = TABLE_COLUMN_META.gl_recon_lines.map(m => ({ ...m, render: LINE_RENDERS[m.id] }))

function AccountLines({ month, account }) {
  const [rows, setRows] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => {
    let live = true
    setRows(null)
    api.quickbooks.glReconLines(month, account.account_qb_id)
      .then(r => { if (live) setRows(r) })
      .catch(e => { if (live) { setError(e.message); setRows([]) } })
    return () => { live = false }
  }, [month, account.account_qb_id])
  return (
    <div className="mt-5" data-testid="gl-recon-lines">
      <div className="text-sm font-medium text-slate-700 mb-2">{account.account_label}</div>
      {error && <ErrorBanner className="mb-3">{error}</ErrorBanner>}
      <DataTable
        table="gl_recon_lines"
        columns={LINE_COLUMNS}
        data={rows || []}
        loading={!rows}
        searchFields={['txn_label', 'doc_number', 'name', 'memo']}
        onRowClick={row => { if (row.qb_url) window.open(row.qb_url, '_blank', 'noopener') }}
        emptyState={{ icon: Scale, title: 'Aucune ligne ce mois-ci' }}
      />
    </div>
  )
}

function MonthAccounts({ month }) {
  const [rows, setRows] = useState(null)
  const [error, setError] = useState(null)
  const [account, setAccount] = useState(null)
  useEffect(() => {
    let live = true
    setRows(null); setAccount(null)
    api.quickbooks.glReconMonth(month)
      .then(r => { if (live) setRows(r.map(a => ({ ...a, id: a.account_qb_id }))) })
      .catch(e => { if (live) { setError(e.message); setRows([]) } })
    return () => { live = false }
  }, [month])
  return (
    <div className="px-5 py-4" data-testid="gl-recon-month">
      {error && <ErrorBanner className="mb-3">{error}</ErrorBanner>}
      <DataTable
        table="gl_recon_accounts"
        columns={ACCOUNT_COLUMNS}
        data={rows || []}
        loading={!rows}
        searchFields={['account_label']}
        onRowClick={row => setAccount(row)}
        emptyState={{ icon: Scale, title: 'Aucun compte' }}
      />
      {account && <AccountLines key={account.account_qb_id} month={month} account={account} />}
    </div>
  )
}

export default function GrandLivre() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const load = useCallback(() => api.quickbooks.glRecon()
    .then(r => { setData(r); setError(null); return r })
    .catch(e => { setError(e.message) }), [])
  useEffect(() => { load() }, [load])

  // Pendant une comparaison, relit l'état toutes les 3 s.
  useEffect(() => {
    if (!data?.running) return
    const t = setTimeout(load, 3000)
    return () => clearTimeout(t)
  }, [data, load])

  const run = async () => {
    try { await api.quickbooks.glReconRun() } catch (e) { setError(e.message) }
    setData(d => ({ ...(d || { months: [] }), running: true }))
  }

  const rows = (data?.months || []).map(m => ({ ...m, id: m.month, status: m.mismatches }))

  return (
    <ListPage
      title="Grand livre ↔ QBO"
      icon={Scale}
      actions={
        <button type="button" className="btn-secondary" onClick={run} disabled={data?.running} data-testid="gl-recon-run">
          <RefreshCw size={15} className={data?.running ? 'animate-spin' : ''} /> Comparer
        </button>
      }
      banner={error && <ErrorBanner className="mb-3">{error}</ErrorBanner>}>
      <DataTable
        table="gl_recon_months"
        columns={MONTH_COLUMNS}
        data={rows}
        loading={!data}
        searchFields={['month']}
        emptyState={{ icon: Scale, title: 'Aucune comparaison' }}
        peek={{
          title: row => monthLabel(row.month),
          subtitle: row => row.mismatches ? `${row.mismatches} écart${row.mismatches > 1 ? 's' : ''}` : 'Identique',
          key: 'gl_recon_months',
          width: 900,
          render: row => <MonthAccounts month={row.month} />,
        }}
      />
    </ListPage>
  )
}
