import { useMemo } from 'react'
import { ShoppingCart } from 'lucide-react'
import { useNavigate, Link } from 'react-router-dom'
import { useTable, isTableHydrated } from '../lib/dataStore.js'
import { Layout } from '../components/Layout.jsx'
import { Badge, PURCHASE_STATUS_COLORS as STATUS_COLORS } from '../components/Badge.jsx'
import { DataTable } from '../components/DataTable.jsx'
import TableThumb from '../components/TableThumb.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'

import { fmtCad } from '../utils/formatters.js'


const RENDERS = {
  image: row => row.product_image
    ? <TableThumb src={row.product_image} className="border border-slate-200" />
    : <span className="text-slate-300">—</span>,
  product_name: row => <div className="font-medium text-slate-900">{row.product_name || '—'}</div>,
  sku: row => row.sku ? <span className="text-slate-500 font-mono">{row.sku}</span> : null,
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
        </div>

        <DataTable
          table="purchases"
          manageViews
          columns={COLUMNS}
          data={purchases}
          loading={loading}
          onRowClick={row => navigate(`/purchases/${row.id}`)}
          searchFields={['product_name', 'supplier', 'supplier_company_name', 'reference']}
          emptyState={{ icon: ShoppingCart, title: 'Aucun achat', description: "Aucune ligne d'achat n'est enregistrée. Les achats de produits apparaissent ici une fois saisis." }}
        />
      </div>
    </Layout>
  )
}
