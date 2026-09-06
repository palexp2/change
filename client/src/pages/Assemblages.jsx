import { Link } from 'react-router-dom'
import api from '../lib/api.js'
import { useListData } from '../lib/useListData.js'
import { ListPage } from '../components/ListPage.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'


const RENDERS = {
  product_name: row => row.product_id
    ? <Link to={`/products/${row.product_id}`} onClick={e => e.stopPropagation()} className="font-medium text-brand-600 hover:underline">{row.product_name || '—'}</Link>
    : <div className="font-medium text-slate-900">{row.product_name || '—'}</div>,
  sku: row => row.sku ? <span className="text-slate-500 font-mono">{row.sku}</span> : null,
  qty_produced: row => <span className="font-bold text-slate-900">{row.qty_produced ?? '—'}</span>,
  assembled_at: row => <span className="text-slate-500">{fmtDate(row.assembled_at)}</span>,
}

const COLUMNS = TABLE_COLUMN_META.assemblages.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

export default function Assemblages() {
  const { rows: assemblages, loading } = useListData({
    fetch: (page, limit) => api.assemblages.list({ limit, page }),
  })

  return (
    <ListPage title="Assemblages">
      <DataTable
        table="assemblages"
        manageViews
        columns={COLUMNS}
        data={assemblages}
        loading={loading}
        searchFields={['product_name', 'sku']}
      />
    </ListPage>
  )
}
