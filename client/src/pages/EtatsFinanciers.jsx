// États financiers calculés par Boréal depuis son grand livre miroir, à côté
// des rapports QBO (BalanceSheet / ProfitAndLoss). Bilan à la fin de la
// période, résultats sur la période. Clic sur un compte → ses lignes du grand
// livre sur la période, chacune ouvrant la transaction dans QBO.
import { useEffect, useMemo, useState } from 'react'
import { FileBarChart, Download } from 'lucide-react'
import api from '../lib/api.js'
import { ListPage } from '../components/ListPage.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { SearchableSelect } from '../components/SearchableSelect.jsx'
import RecordPeekDrawer from '../components/RecordPeekDrawer.jsx'
import ErrorBanner from '../components/ErrorBanner.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtMoney } from '../utils/formatters.js'

const pad = n => String(n).padStart(2, '0')
const today = () => new Date().toLocaleDateString('en-CA')
const lastDay = (y, m) => `${y}-${pad(m)}-${pad(new Date(y, m, 0).getDate())}`
// Mois `m` (1-12, peut déborder) de l'année `y` → [année, mois] normalisés.
const norm = (y, m) => [y + Math.floor((m - 1) / 12), ((m - 1) % 12 + 12) % 12 + 1]
const fyLabel = (y, fsm) => fsm === 1 ? String(y) : `${y}-${String(y + 1).slice(2)}`

// Périodes proposées, la plus récente d'abord ; `to` plafonné à aujourd'hui.
function periodOptions(kind, fsm) {
  const t = today()
  const [ty, tm] = t.split('-').map(Number)
  const fyStart = tm >= fsm ? ty : ty - 1
  const out = []
  const push = (label, [y1, m1], [y2, m2]) => {
    const to = lastDay(y2, m2)
    out.push({ value: `${y1}-${pad(m1)}-01|${to < t ? to : t}`, label })
  }
  if (kind === 'month') {
    for (let i = 0; i < 36; i++) {
      const ym = norm(ty, tm - i)
      push(new Date(ym[0], ym[1] - 1, 1).toLocaleDateString('fr-CA', { month: 'long', year: 'numeric' }), ym, ym)
    }
  } else if (kind === 'quarter') {
    const q0 = Math.floor(((tm - fsm + 12) % 12) / 3)
    for (let i = 0; i < 12; i++) {
      const k = q0 - i
      const fy = fyStart + Math.floor(k / 4)
      const q = ((k % 4) + 4) % 4
      push(`T${q + 1} ${fyLabel(fy, fsm)}`, norm(fy, fsm + q * 3), norm(fy, fsm + q * 3 + 2))
    }
  } else {
    for (let i = 0; i < 8; i++) push(fyLabel(fyStart - i, fsm), norm(fyStart - i, fsm), norm(fyStart - i, fsm + 11))
  }
  return out
}

const KINDS = [['month', 'Mois'], ['quarter', 'Trimestre'], ['year', 'Exercice']]
const TABS = [['balance', 'Bilan'], ['income', 'Résultats']]

const money = v => v == null ? <span className="text-slate-300">—</span> : <span className="tabular-nums">{fmtMoney(v, 'CAD')}</span>
const RENDERS = {
  label: row => <span style={{ paddingLeft: row.depth * 16 }} className={row.kind === 'account' ? 'text-slate-700' : 'font-semibold text-slate-900'}>{row.label}</span>,
  boreal: row => money(row.boreal),
  qbo: row => money(row.qbo),
  diff: row => row.diff ? <span className="tabular-nums font-medium text-red-700">{fmtMoney(row.diff, 'CAD')}</span> : null,
}
const COLUMNS = TABLE_COLUMN_META.gl_statement.map(m => ({ ...m, render: RENDERS[m.id] }))

const LINE_RENDERS = {
  debit: row => row.debit ? money(row.debit) : null,
  credit: row => row.credit ? money(row.credit) : null,
}
const LINE_COLUMNS = TABLE_COLUMN_META.gl_statement_lines.map(m => ({ ...m, render: LINE_RENDERS[m.id] }))

function AccountLines({ account, from, to }) {
  const [rows, setRows] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => {
    let live = true
    setRows(null); setError(null)
    api.quickbooks.glAccountLines(account.account_qb_id, from, to)
      .then(r => { if (live) setRows(r) })
      .catch(e => { if (live) { setError(e.message); setRows([]) } })
    return () => { live = false }
  }, [account.account_qb_id, from, to])
  return (
    <div className="px-5 py-4" data-testid="gl-statement-lines">
      {error && <ErrorBanner className="mb-3">{error}</ErrorBanner>}
      <DataTable
        table="gl_statement_lines"
        columns={LINE_COLUMNS}
        data={rows || []}
        loading={!rows}
        searchFields={['txn_label', 'doc_number', 'name', 'memo', 'account_label']}
        onRowClick={row => { if (row.qb_url) window.open(row.qb_url, '_blank', 'noopener') }}
        emptyState={{ icon: FileBarChart, title: 'Aucune ligne' }}
      />
    </div>
  )
}

function exportCsv(rows, name) {
  const q = v => /[",;\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? '')
  const lines = [['Compte', 'Boréal', 'QBO', 'Écart'].join(','),
    ...rows.map(r => [`${'  '.repeat(r.depth)}${r.label}`, r.boreal, r.qbo ?? '', r.diff ?? ''].map(q).join(','))]
  const url = URL.createObjectURL(new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' }))
  const a = Object.assign(document.createElement('a'), { href: url, download: name })
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export default function EtatsFinanciers() {
  const [fsm, setFsm] = useState(4)
  const [kind, setKind] = useState('year')
  const [period, setPeriod] = useState(null)
  const [tab, setTab] = useState('balance')
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [account, setAccount] = useState(null)

  const options = useMemo(() => periodOptions(kind, fsm), [kind, fsm])
  const value = options.some(o => o.value === period) ? period : options[0].value
  const [from, to] = value.split('|')

  useEffect(() => {
    let live = true
    setData(null); setError(null)
    api.quickbooks.glStatements(from, to)
      .then(r => { if (!live) return; setData(r); if (r.fiscal_start_month) setFsm(r.fiscal_start_month) })
      .catch(e => { if (live) setError(e.message) })
    return () => { live = false }
  }, [from, to])

  const rows = useMemo(() => data?.[tab] || [], [data, tab])
  const columns = useMemo(() => rows.some(r => r.diff) ? COLUMNS : COLUMNS.filter(c => c.id !== 'diff'), [rows])
  const segBtn = active => `px-2.5 h-7 rounded-md text-xs font-medium transition-colors ${active ? 'bg-slate-100 text-slate-800' : 'text-slate-500 hover:text-slate-700'}`
  const seg = (items, cur, set, label) => (
    <div className="flex items-center rounded-lg border border-slate-200 p-0.5" role="tablist" aria-label={label}>
      {items.map(([v, l]) => (
        <button key={v} type="button" role="tab" aria-selected={cur === v} onClick={() => set(v)}
          className={segBtn(cur === v)} data-testid={`fs-${v}`}>{l}</button>
      ))}
    </div>
  )

  return (
    <ListPage
      title="États financiers"
      icon={FileBarChart}
      actions={
        <>
          {seg(KINDS, kind, setKind, 'Période')}
          <div className="w-44">
            <SearchableSelect value={value} options={options} onChange={setPeriod} testId="fs-period" className="input-field text-sm w-full capitalize" />
          </div>
          <button type="button" className="btn-secondary" disabled={!rows.length} data-testid="fs-export"
            onClick={() => exportCsv(rows, tab === 'balance' ? `bilan-${to}.csv` : `resultats-${from}-${to}.csv`)}>
            <Download size={15} /> CSV
          </button>
        </>
      }
      banner={(error || data?.qbo_error) && <ErrorBanner className="mb-3">{error || `QBO : ${data.qbo_error}`}</ErrorBanner>}>
      <DataTable
        table="gl_statement"
        columns={columns}
        data={rows}
        loading={!data && !error}
        searchFields={['label']}
        toolbarStart={seg(TABS, tab, setTab, 'État')}
        rowClassName={row => row.kind === 'account' ? '' : 'bg-slate-50'}
        onRowClick={row => { if (row.account_qb_id) setAccount(row) }}
        emptyState={{ icon: FileBarChart, title: 'Aucun compte' }}
      />
      <RecordPeekDrawer open={!!account} onClose={() => setAccount(null)} title={account?.label || ''}
        subtitle={`${from} → ${to}`} width={900} peekKey="gl_statement_lines">
        {account && <AccountLines key={account.account_qb_id} account={account} from={from} to={to} />}
      </RecordPeekDrawer>
    </ListPage>
  )
}
