import { useState, useEffect, useCallback } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import api from '../lib/api.js'
import { loadProgressive } from '../lib/loadAll.js'
import { Layout } from '../components/Layout.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TableConfigModal } from '../components/TableConfigModal.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'


const RENDERS = {
  serial: row => <span className="font-mono font-medium text-slate-900">{row.serial}</span>,
  product_name: row => row.product_id
    ? <Link to={`/products/${row.product_id}`} onClick={e => e.stopPropagation()} className="text-indigo-600 hover:underline">{row.product_name || row.sku || '—'}</Link>
    : <span className="text-slate-400">—</span>,
  company_name: row => row.company_id
    ? <Link to={`/companies/${row.company_id}`} onClick={e => e.stopPropagation()} className="text-indigo-600 hover:underline">{row.company_name}</Link>
    : <span className="text-slate-400">—</span>,
  manufacture_date: row => <span className="text-slate-500">{fmtDate(row.manufacture_date)}</span>,
}

const COLUMNS = TABLE_COLUMN_META.serial_numbers.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

export default function SerialNumbers() {
  const navigate = useNavigate()
  const [serials, setSerials] = useState([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    await loadProgressive(
      (page, limit) => api.serials.list({ limit, page }),
      setSerials, setLoading
    )
  }, [])

  useEffect(() => { load() }, [load])

  return (
    <Layout>
      <div className="p-6 max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Numéros de série</h1>
          </div>
          <TableConfigModal table="serial_numbers" />
        </div>

        <DataTable
          table="serial_numbers"
          columns={COLUMNS}
          data={serials}
          loading={loading}
          searchFields={['serial', 'product_name', 'company_name']}
          onRowClick={row => navigate(`/serials/${row.id}`)}
        />
      </div>
    </Layout>
  )
}
