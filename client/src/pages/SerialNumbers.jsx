import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useTable, isTableHydrated } from '../lib/dataStore.js'
import { Layout } from '../components/Layout.jsx'
import { PageTitle } from '../components/PageTitle.jsx'
import { DataTable } from '../components/DataTable.jsx'
import SerialDetail from './SerialDetail.jsx'
import { usePeekOpenId } from '../lib/usePeekOpenId.js'
import { CentralControllerPermissions } from '../components/CentralControllerPermissions.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'


const RENDERS = {
  serial: row => <span className="font-mono font-medium text-slate-900">{row.serial}</span>,
  product_name: row => row.product_id
    ? <Link to={`/products/${row.product_id}`} onClick={e => e.stopPropagation()} className="text-brand-600 hover:underline">{row.product_name || row.sku || '—'}</Link>
    : <span className="text-slate-400">—</span>,
  company_name: row => row.company_id
    ? <Link to={`/companies/${row.company_id}`} onClick={e => e.stopPropagation()} className="text-brand-600 hover:underline">{row.company_name}</Link>
    : <span className="text-slate-400">—</span>,
  address: row => row.address
    ? <span className="font-mono text-slate-700">{row.address}</span>
    : <span className="text-slate-400">—</span>,
  permissions: row => {
    if (!row.permissions || typeof row.permissions !== 'object' || Object.keys(row.permissions).length === 0) {
      return <span className="text-slate-400">—</span>
    }
    return <CentralControllerPermissions permissions={row.permissions} compact />
  },
  manufacture_date: row => <span className="text-slate-500">{fmtDate(row.manufacture_date)}</span>,
}

const COLUMNS = TABLE_COLUMN_META.serial_numbers.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

export default function SerialNumbers() {
  const { peekOpenId, consumePeekOpen } = usePeekOpenId()

  const serialsRaw = useTable('serial_numbers')
  const products = useTable('products')
  const companies = useTable('companies')
  const loading = !isTableHydrated('serial_numbers')

  const serials = useMemo(() => {
    const pById = new Map(products.map(p => [p.id, p]))
    const cById = new Map(companies.map(c => [c.id, c.name]))
    return serialsRaw
      .filter(r => !r.deleted_at)
      .map(r => {
        const p = r.product_id ? pById.get(r.product_id) : null
        let permissions = r.permissions
        if (typeof permissions === 'string' && permissions) {
          try { permissions = JSON.parse(permissions) } catch { permissions = null }
        }
        return {
          ...r,
          product_name: p?.name_fr || p?.name_en || r.product_name,
          sku: p?.sku || r.sku,
          company_name: cById.get(r.company_id) || r.company_name,
          permissions,
        }
      })
  }, [serialsRaw, products, companies])

  return (
    <Layout>
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <PageTitle>Numéros de série</PageTitle>
          </div>
        </div>

        <DataTable
          table="serial_numbers"
          manageViews
          columns={COLUMNS}
          data={serials}
          loading={loading}
          searchFields={['serial', 'product_name', 'company_name']}
          peek={{
            title: row => row.serial || `Numéro de série #${row.id}`,
            subtitle: row => row.company_name || row.product_name || '',
            to: row => `/serials/${row.id}`,
            width: 680,
            openId: peekOpenId,
            onOpenConsumed: consumePeekOpen,
            render: row => <SerialDetail recordId={row.id} embedded />,
          }}
        />
      </div>
    </Layout>
  )
}
