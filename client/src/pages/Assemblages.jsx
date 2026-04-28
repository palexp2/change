import { useState, useEffect, useCallback } from 'react'
import api from '../lib/api.js'
import { loadProgressive } from '../lib/loadAll.js'
import { Layout } from '../components/Layout.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TableConfigModal } from '../components/TableConfigModal.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'


const RENDERS = {
  product_name: row => (
    <div>
      <div className="font-medium text-slate-900">{row.product_name || '—'}</div>
      {row.sku && <div className="text-xs text-slate-400 font-mono">{row.sku}</div>}
    </div>
  ),
  qty_produced: row => <span className="font-bold text-slate-900">{row.qty_produced ?? '—'}</span>,
  assembled_at: row => <span className="text-slate-500">{fmtDate(row.assembled_at)}</span>,
}

const COLUMNS = TABLE_COLUMN_META.assemblages.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

export default function Assemblages() {
  const [assemblages, setAssemblages] = useState([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    await loadProgressive(
      (page, limit) => api.assemblages.list({ limit, page }),
      setAssemblages, setLoading
    )
  }, [])

  useEffect(() => { load() }, [load])

  return (
    <Layout>
      <div className="p-6 max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Assemblages</h1>
          </div>
          <TableConfigModal table="assemblages" />
        </div>

        <DataTable
          table="assemblages"
          columns={COLUMNS}
          data={assemblages}
          loading={loading}
          searchFields={['product_name', 'sku']}
        />
      </div>
    </Layout>
  )
}
