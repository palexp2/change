import { useMemo, useState, useCallback } from 'react'
import { Undo2 } from 'lucide-react'
import { useNavigate, useLocation, Link } from 'react-router-dom'
import { useTable, isTableHydrated } from '../lib/dataStore.js'
import { Layout } from '../components/Layout.jsx'
import { Badge, RETOUR_STATUS_COLORS as STATUS_COLORS } from '../components/Badge.jsx'
import { DataTable } from '../components/DataTable.jsx'
import RetourDetail from './RetourDetail.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'



const RENDERS = {
  return_number:     row => <span className="font-mono font-medium text-slate-900">{row.return_number || '—'}</span>,
  company_name:      row => row.company_id
    ? <Link to={`/companies/${row.company_id}`} onClick={e => e.stopPropagation()} className="text-brand-600 hover:underline">{row.company_name}</Link>
    : <span className="text-slate-400">—</span>,
  tracking_number:   row => <span className="font-mono text-xs text-slate-600">{row.tracking_number || '—'}</span>,
  processing_status: row => row.processing_status
    ? <Badge color={STATUS_COLORS[row.processing_status] || 'gray'}>{row.processing_status}</Badge>
    : <span className="text-slate-400">—</span>,
  created_at: row => <span className="text-slate-500">{fmtDate(row.created_at)}</span>,
}

const COLUMNS = TABLE_COLUMN_META.retours.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

export default function Retours() {
  const navigate = useNavigate()
  const location = useLocation()

  const retoursRaw = useTable('returns')
  const companies = useTable('companies')
  const loading = !isTableHydrated('returns')

  const retours = useMemo(() => {
    const cById = new Map(companies.map(c => [c.id, c.name]))
    return retoursRaw.map(r => ({
      ...r,
      company_name: cById.get(r.company_id) || r.company_name,
    }))
  }, [retoursRaw, companies])

  // Ouverture du side-peek demandée par la fiche plein écran (« revenir au
  // panneau latéral ») — même pattern que Companies.jsx / Factures.jsx.
  const [peekOpenId, setPeekOpenId] = useState(() => location.state?.peekId ?? null)
  const consumePeekOpen = useCallback(() => {
    setPeekOpenId(null)
    navigate(location.pathname + location.search, { replace: true, state: null })
  }, [navigate, location.pathname, location.search])

  return (
    <Layout>
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Retours</h1>
          </div>
        </div>

        <DataTable
          table="retours"
          manageViews
          columns={COLUMNS}
          data={retours}
          loading={loading}
          peek={{
            title: row => row.return_number || `Retour #${row.id}`,
            subtitle: row => row.company_name,
            to: row => `/retours/${row.id}`,
            width: 720,
            openId: peekOpenId,
            onOpenConsumed: consumePeekOpen,
            render: (row, { close }) => <RetourDetail recordId={row.id} embedded onClose={close} />,
          }}
          searchFields={['return_number', 'tracking_number', 'company_name']}
          emptyState={{ icon: Undo2, title: 'Aucun retour', description: "Aucune demande de retour (RMA) n'a été enregistrée. Les retours clients apparaissent ici." }}
        />
      </div>
    </Layout>
  )
}
