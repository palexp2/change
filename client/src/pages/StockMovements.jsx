import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import api from '../lib/api.js'
import { loadProgressive } from '../lib/loadAll.js'
import { Layout } from '../components/Layout.jsx'
import { Badge } from '../components/Badge.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TableConfigModal } from '../components/TableConfigModal.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'

function money(n) {
  if (n == null) return <span className="text-slate-300">—</span>
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 2 }).format(n)
}

function num(n) {
  if (n == null) return <span className="text-slate-300">—</span>
  return Number(n).toLocaleString('fr-CA')
}

const TYPE_COLORS = {
  in: 'green',
  out: 'red',
  adjustment: 'yellow',
}

const TYPE_LABELS = {
  in: 'Entrée',
  out: 'Sortie',
  adjustment: 'Ajustement',
}

const RENDERS = {
  created_at:     row => <span className="text-slate-500">{fmtDate(row.created_at)}</span>,
  product_sku:    row => <span className="font-mono text-slate-700">{row.product_sku || '—'}</span>,
  product_name:   row => row.product_id
    ? <Link to={`/products/${row.product_id}`} onClick={e => e.stopPropagation()} className="text-indigo-600 hover:underline">{row.product_name || '—'}</Link>
    : <span className="text-slate-400">{row.product_name || '—'}</span>,
  type:           row => row.type
    ? <Badge color={TYPE_COLORS[row.type] || 'gray'}>{TYPE_LABELS[row.type] || row.type}</Badge>
    : <span className="text-slate-400">—</span>,
  qty:            row => <span className="font-medium">{num(row.qty)}</span>,
  unit_cost:      row => <span className="text-slate-700">{money(row.unit_cost)}</span>,
  movement_value: row => <span className="font-medium text-slate-700">{money(row.movement_value)}</span>,
}

const COLUMNS = TABLE_COLUMN_META.stock_movements.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

export default function StockMovements() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    await loadProgressive(
      (page, limit) => api.stockMovements.list({ limit, page }),
      setRows, setLoading
    )
  }, [])

  useEffect(() => { load() }, [load])

  return (
    <Layout>
      <div className="p-6 max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-slate-900">Mouvements d'inventaire</h1>
          <div className="flex items-center gap-2">
            <TableConfigModal table="stock_movements" />
          </div>
        </div>

        <DataTable
          table="stock_movements"
          columns={COLUMNS}
          data={rows}
          loading={loading}
          searchFields={['product_sku', 'product_name', 'reason', 'reference_id']}
        />
      </div>
    </Layout>
  )
}
