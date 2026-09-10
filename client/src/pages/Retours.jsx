import { useCallback } from 'react'
import { Undo2 } from 'lucide-react'
import api from '../lib/api.js'
import { patchRecord } from '../lib/dataStore.js'
import { useToast } from '../contexts/ToastContext.jsx'
import { usePeekOpenId } from '../lib/usePeekOpenId.js'
import { useListData } from '../lib/useListData.js'
import { ListPage } from '../components/ListPage.jsx'
import { DataTable } from '../components/DataTable.jsx'
import RetourDetail from './RetourDetail.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'



const RENDERS = {
  created_at: row => <span className="text-slate-500">{fmtDate(row.created_at)}</span>,
}

const COLUMNS = TABLE_COLUMN_META.retours.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

export default function Retours() {

  // Un retour ne porte plus ni entreprise, ni contact, ni n° RMA (colonnes
  // droppées, migration serveur 037), ni statut (041) : la liste affiche ce que
  // la table garde, plus les champs Airtable pilotés depuis /champs/retours.
  const { rows: retours, loading } = useListData({ table: 'returns' })

  const { peekOpenId, consumePeekOpen } = usePeekOpenId()
  const { addToast } = useToast()

  // Édition en ligne (mode tableur). Seuls les champs bidirectionnels sont
  // éditables — DataTable le sait par `writable`, le serveur le revérifie.
  const updateField = useCallback(async (row, col, value) => {
    try {
      await api.retours.update(row.id, { [col.field]: value })
      patchRecord('returns', row.id, { [col.field]: value })
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    }
  }, [addToast])

  return (
    <ListPage title="Retours">
      <DataTable
        table="retours"
        manageViews
        columns={COLUMNS}
        data={retours}
        loading={loading}
        onCellEdit={updateField}
        peek={{
          title: () => 'Retour',
          to: row => `/retours/${row.id}`,
          width: 720,
          openId: peekOpenId,
          onOpenConsumed: consumePeekOpen,
          render: (row, { close }) => <RetourDetail recordId={row.id} embedded onClose={close} />,
        }}
        // Le statut était le dernier champ natif cherchable (droppé par la 041) :
        // il ne reste que l'identifiant du retour.
        searchFields={['id']}
        emptyState={{ icon: Undo2, title: 'Aucun retour', description: "Aucune demande de retour (RMA) n'a été enregistrée. Les retours clients apparaissent ici." }}
      />
    </ListPage>
  )
}
