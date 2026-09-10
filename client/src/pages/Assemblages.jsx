import { Link } from 'react-router-dom'
import api from '../lib/api.js'
import { useListData } from '../lib/useListData.js'
import { useTable } from '../lib/dataStore.js'
import { ListPage } from '../components/ListPage.jsx'
import { DataTable } from '../components/DataTable.jsx'
import LinkedRecordField from '../components/LinkedRecordField.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'

const today = () => new Date().toISOString().slice(0, 10)

const RENDERS = {
  product_name: row => row.product_id
    ? <Link to={`/products/${row.product_id}`} onClick={e => e.stopPropagation()} className="font-medium link-record">{row.product_name || '—'}</Link>
    : <div className="font-medium text-slate-900">{row.product_name || '—'}</div>,
  sku: row => row.sku ? <span className="text-slate-500 font-mono">{row.sku}</span> : null,
  qty_produced: row => <span className="font-bold text-slate-900">{row.qty_produced ?? '—'}</span>,
  assembled_at: row => <span className="text-slate-500">{fmtDate(row.assembled_at)}</span>,
}

const COLUMNS = TABLE_COLUMN_META.assemblages.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

export default function Assemblages() {
  const { rows: assemblages, loading, reload } = useListData({
    fetch: (page, limit) => api.assemblages.list({ limit, page }),
  })
  const products = useTable('products')

  async function handleCreate(form) {
    await api.assemblages.create(form)
    await reload()
  }

  return (
    <ListPage
      title="Assemblages"
      create={{
        label: 'Loguer un assemblage',
        table: 'assemblages',
        fields: [
          {
            field: 'product_id', label: 'Produit', span: 2, required: true,
            input: ({ value, onChange }) => (
              <LinkedRecordField
                name="assemblage_product_id"
                value={value || ''}
                options={products}
                labelFn={p => p.name_fr || p.sku}
                getHref={p => `/products/${p.id}`}
                onChange={onChange}
              />
            ),
          },
          { field: 'qty_produced', label: 'Quantité produite', type: 'number', min: 1, defaultValue: 1, required: true },
          { field: 'assembled_at', label: 'Date', type: 'date', defaultValue: today() },
        ],
        onSubmit: handleCreate,
      }}
    >
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
