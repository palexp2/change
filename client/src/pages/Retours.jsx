import { Undo2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import { usePeekOpenId } from '../lib/usePeekOpenId.js'
import { useListData } from '../lib/useListData.js'
import { ListPage } from '../components/ListPage.jsx'
import { DataTable } from '../components/DataTable.jsx'
import RetourDetail from './RetourDetail.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'



const RENDERS = {
  n_de_retour:       row => <span className="font-mono font-medium text-slate-900">{row.n_de_retour || '—'}</span>,
  company_name:      row => row.company_id
    ? <Link to={`/companies/${row.company_id}`} onClick={e => e.stopPropagation()} className="text-brand-600 hover:underline">{row.company_name}</Link>
    : <span className="text-slate-400">—</span>,
  created_at: row => <span className="text-slate-500">{fmtDate(row.created_at)}</span>,
}

const COLUMNS = TABLE_COLUMN_META.retours.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

export default function Retours() {

  // « Entreprise » n'est plus jointe côté client : c'est un champ perso (lookup
  // sur company_id) et sa valeur arrive dans le snapshot par la vue returns_v.
  // Le recopier d'ici ferait survivre la colonne à la suppression du champ.
  const { rows: retours, loading } = useListData({ table: 'returns' })

  const { peekOpenId, consumePeekOpen } = usePeekOpenId()

  return (
    <ListPage title="Retours">
      <DataTable
        table="retours"
        manageViews
        columns={COLUMNS}
        data={retours}
        loading={loading}
        peek={{
          title: row => row.n_de_retour || `Retour #${row.id}`,
          subtitle: row => row.company_name,
          to: row => `/retours/${row.id}`,
          width: 720,
          openId: peekOpenId,
          onOpenConsumed: consumePeekOpen,
          render: (row, { close }) => <RetourDetail recordId={row.id} embedded onClose={close} />,
        }}
        searchFields={['n_de_retour', 'company_name']}
        emptyState={{ icon: Undo2, title: 'Aucun retour', description: "Aucune demande de retour (RMA) n'a été enregistrée. Les retours clients apparaissent ici." }}
      />
    </ListPage>
  )
}
