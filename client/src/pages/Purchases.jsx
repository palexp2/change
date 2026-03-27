import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { Badge } from '../components/Badge.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TableConfigModal } from '../components/TableConfigModal.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'

const STATUS_COLORS = { 'Commandé': 'blue', 'Reçu partiellement': 'yellow', 'Reçu': 'green', 'Annulé': 'red' }

function fmtCad(n) {
  if (!n && n !== 0) return '—'
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD' }).format(n)
}

function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('fr-CA', { month: 'short', day: 'numeric', year: 'numeric' })
}

const RENDERS = {
  product_name: row => (
    <div>
      <div className="font-medium text-slate-900">{row.product_name || '—'}</div>
      {row.sku && <div className="text-xs text-slate-400 font-mono">{row.sku}</div>}
    </div>
  ),
  status: row => <Badge color={STATUS_COLORS[row.status] || 'gray'}>{row.status}</Badge>,
  unit_cost: row => <span className="text-slate-500">{row.unit_cost ? fmtCad(row.unit_cost) : '—'}</span>,
  order_date: row => <span className="text-slate-500">{fmtDate(row.order_date)}</span>,
  expected_date: row => <span className="text-slate-500">{fmtDate(row.expected_date)}</span>,
}

const COLUMNS = TABLE_COLUMN_META.purchases.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

export default function Purchases() {
  const navigate = useNavigate()
  const [purchases, setPurchases] = useState([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.purchases.list({ limit: 'all' })
      setPurchases(res.data)
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
            <h1 className="text-2xl font-bold text-slate-900">Achats</h1>
            <p className="text-sm text-slate-500 mt-0.5">{purchases.length} achat{purchases.length !== 1 ? 's' : ''}</p>
          </div>
          <TableConfigModal table="purchases" />
        </div>

        <DataTable
          table="purchases"
          columns={COLUMNS}
          data={purchases}
          loading={loading}
          onRowClick={row => row.product_id && navigate(`/products/${row.product_id}`)}
          searchFields={['product_name', 'supplier', 'reference']}
        />
      </div>
    </Layout>
  )
}
