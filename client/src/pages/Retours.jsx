import { useState, useEffect, useCallback } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { Badge } from '../components/Badge.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TableConfigModal } from '../components/TableConfigModal.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'

function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('fr-CA', { month: 'short', day: 'numeric', year: 'numeric' })
}

const STATUS_COLORS = {
  'Reçu': 'green',
  'En attente': 'yellow',
  'En traitement': 'blue',
  'Refusé': 'red',
}

const RENDERS = {
  return_number:     row => <span className="font-mono font-medium text-slate-900">{row.return_number || '—'}</span>,
  company_name:      row => row.company_id
    ? <Link to={`/companies/${row.company_id}`} onClick={e => e.stopPropagation()} className="text-indigo-600 hover:underline">{row.company_name}</Link>
    : <span className="text-slate-400">—</span>,
  tracking_number:   row => <span className="font-mono text-xs text-slate-600">{row.tracking_number || '—'}</span>,
  processing_status: row => row.processing_status
    ? <Badge color={STATUS_COLORS[row.processing_status] || 'gray'}>{row.processing_status}</Badge>
    : <span className="text-slate-400">—</span>,
  created_at: row => <span className="text-slate-500">{fmtDate(row.created_at)}</span>,
}

const COLUMNS = TABLE_COLUMN_META.retours.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

export default function Retours() {
  const navigate = useNavigate()
  const [retours, setRetours] = useState([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.retours.list({ limit: 'all' })
      setRetours(res.data)
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
            <h1 className="text-2xl font-bold text-slate-900">Retours</h1>
            <p className="text-sm text-slate-500 mt-0.5">{retours.length} retour{retours.length !== 1 ? 's' : ''}</p>
          </div>
          <TableConfigModal table="retours" />
        </div>

        <DataTable
          table="retours"
          columns={COLUMNS}
          data={retours}
          loading={loading}
          onRowClick={row => navigate(`/retours/${row.id}`)}
          searchFields={['return_number', 'tracking_number']}
        />
      </div>
    </Layout>
  )
}
