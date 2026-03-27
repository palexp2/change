import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import api from '../lib/api.js'
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
  'Payée': 'green',
  'Partielle': 'yellow',
  'En retard': 'red',
  'Envoyée': 'blue',
  'Brouillon': 'gray',
  'Annulée': 'red',
}

const RENDERS = {
  document_number: row => <span className="font-mono font-medium text-slate-900">{row.document_number || '—'}</span>,
  company_name:    row => row.company_id
    ? <Link to={`/companies/${row.company_id}`} onClick={e => e.stopPropagation()} className="text-indigo-600 hover:underline">{row.company_name}</Link>
    : <span className="text-slate-400">—</span>,
  project_name:    row => <span className="text-slate-600">{row.project_name || '—'}</span>,
  status:          row => row.status
    ? <Badge color={STATUS_COLORS[row.status] || 'gray'}>{row.status}</Badge>
    : <span className="text-slate-400">—</span>,
  document_date:   row => <span className="text-slate-500">{fmtDate(row.document_date)}</span>,
  due_date:        row => <span className="text-slate-500">{fmtDate(row.due_date)}</span>,
  total_cad:       row => <span className="font-medium text-slate-700">{fmtCad(row.total_cad)}</span>,
  balance_due_cad: row => {
    const val = row.balance_due_cad
    if (!val && val !== 0) return <span className="text-slate-400">—</span>
    return <span className={`font-medium ${val > 0 ? 'text-red-600' : 'text-green-600'}`}>{fmtCad(val)}</span>
  },
}

const COLUMNS = TABLE_COLUMN_META.factures.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

export default function Factures() {
  const [factures, setFactures] = useState([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.factures.list({ limit: 'all' })
      setFactures(res.data)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  return (
    <Layout>
      <div className="p-6 max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Factures</h1>
            <p className="text-sm text-slate-500 mt-0.5">{factures.length} facture{factures.length !== 1 ? 's' : ''}</p>
          </div>
          <TableConfigModal table="factures" />
        </div>

        <DataTable
          table="factures"
          columns={COLUMNS}
          data={factures}
          loading={loading}
          searchFields={['document_number']}
        />
      </div>
    </Layout>
  )
}
