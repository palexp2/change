import { Link } from 'react-router-dom'
import api from '../lib/api.js'
import { useListData } from '../lib/useListData.js'
import { ListPage } from '../components/ListPage.jsx'
import { Badge } from '../components/Badge.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TABLE_COLUMN_META, STOCK_MOVEMENT_TYPE_COLORS as TYPE_COLORS, stockMovementSignedQty as signedQty } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'
import { fmtMoney, fmtNumber } from '../utils/formatters.js'

const DASH = <span className="text-slate-300">—</span>
const money = n => fmtMoney(n, 'CAD', { fallback: DASH })
const num = n => fmtNumber(n, { fallback: DASH })

const RENDERS = {
  created_at:     row => <span className="text-slate-500">{fmtDate(row.created_at)}</span>,
  product_sku:    row => <span className="font-mono text-slate-700">{row.product_sku || '—'}</span>,
  product_name:   row => row.product_id
    ? <Link to={`/products/${row.product_id}`} onClick={e => e.stopPropagation()} className="link-record">{row.product_name || '—'}</Link>
    : <span className="text-slate-400">{row.product_name || '—'}</span>,
  type:           row => row.reason
    ? <Badge color={TYPE_COLORS[row.reason] || 'gray'}>{row.reason}</Badge>
    : <span className="text-slate-400">—</span>,
  qty:            row => <span className="font-medium">{num(signedQty(row))}</span>,
  unit_cost:      row => <span className="text-slate-700">{money(row.unit_cost)}</span>,
  movement_value: row => <span className="font-medium text-slate-700">{money(row.movement_value)}</span>,
}

const COLUMNS = TABLE_COLUMN_META.stock_movements.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

export default function StockMovements() {
  const { rows, loading } = useListData({
    fetch: (page, limit) => api.stockMovements.list({ limit, page }),
  })

  return (
    <ListPage title="Mouvements d'inventaire">
      <DataTable
        table="stock_movements"
        manageViews
        columns={COLUMNS}
        data={rows}
        loading={loading}
        searchFields={['product_sku', 'product_name', 'reason', 'movement_value', 'unit_cost']}
      />
    </ListPage>
  )
}
