import { useMemo } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useTable, isTableHydrated } from '../lib/dataStore.js'
import { Layout } from '../components/Layout.jsx'
import { Badge } from '../components/Badge.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TableConfigModal } from '../components/TableConfigModal.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'

const STATUS_COLORS = { 'Commandé': 'blue', 'Reçu partiellement': 'yellow', 'Reçu': 'green', 'Annulé': 'red' }

function fmtCad(n) {
  if (!n && n !== 0) return '—'
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD' }).format(n)
}


const RENDERS = {
  image: row => row.product_image
    ? <img src={row.product_image} alt="" className="h-10 w-10 object-cover rounded border border-slate-200" loading="lazy" />
    : <span className="text-slate-300">—</span>,
  product_name: row => (
    <div>
      <div className="font-medium text-slate-900">{row.product_name || '—'}</div>
      {row.sku && <div className="text-xs text-slate-400 font-mono">{row.sku}</div>}
    </div>
  ),
  supplier: row => {
    if (row.supplier_company_id && row.supplier_company_name) {
      return (
        <Link
          to={`/companies/${row.supplier_company_id}`}
          onClick={e => e.stopPropagation()}
          className="text-brand-600 hover:underline"
        >
          {row.supplier_company_name}
        </Link>
      )
    }
    return <span className="text-slate-500">{row.supplier || '—'}</span>
  },
  status: row => <Badge color={STATUS_COLORS[row.status] || 'gray'}>{row.status}</Badge>,
  unit_cost: row => <span className="text-slate-500">{row.unit_cost ? fmtCad(row.unit_cost) : '—'}</span>,
  order_date: row => <span className="text-slate-500">{fmtDate(row.order_date)}</span>,
  expected_date: row => <span className="text-slate-500">{fmtDate(row.expected_date)}</span>,
}

const COLUMNS = TABLE_COLUMN_META.purchases.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

export default function Purchases() {
  const navigate = useNavigate()

  const purchasesRaw = useTable('purchases')
  const products = useTable('products')
  const companies = useTable('companies')
  const loading = !isTableHydrated('purchases')

  const purchases = useMemo(() => {
    const pById = new Map(products.map(p => [p.id, p]))
    const cById = new Map(companies.map(c => [c.id, c.name]))
    return purchasesRaw.map(r => {
      const p = r.product_id ? pById.get(r.product_id) : null
      return {
        ...r,
        product_name: p?.name_fr || p?.name_en || r.product_name,
        sku: p?.sku || r.sku,
        product_image: p?.image_url || r.product_image,
        supplier_company_name: cById.get(r.supplier_company_id) || r.supplier_company_name,
      }
    })
  }, [purchasesRaw, products, companies])

  return (
    <Layout>
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Achats</h1>
          </div>
          <TableConfigModal table="purchases" />
        </div>

        <DataTable
          table="purchases"
          columns={COLUMNS}
          data={purchases}
          loading={loading}
          onRowClick={row => navigate(`/purchases/${row.id}`)}
          searchFields={['product_name', 'supplier', 'supplier_company_name', 'reference']}
        />
      </div>
    </Layout>
  )
}
