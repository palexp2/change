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
}

const COLUMNS = TABLE_COLUMN_META.abonnements.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

export default function Abonnements() {
  const [abonnements, setAbonnements] = useState([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.abonnements.list({ limit: 'all' })
      setAbonnements(res.data)
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
            <h1 className="text-2xl font-bold text-slate-900">Abonnements</h1>
            <p className="text-sm text-slate-500 mt-0.5">{abonnements.length} abonnement{abonnements.length !== 1 ? 's' : ''}</p>
          </div>
          <TableConfigModal table="abonnements" />
        </div>

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
