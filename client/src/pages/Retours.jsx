import { useCallback, useMemo } from 'react'
import { Undo2 } from 'lucide-react'
import api from '../lib/api.js'
import { patchRecord, useTable } from '../lib/dataStore.js'
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

  // Recherche par entreprise. La colonne « Entreprise » d'un retour est un champ
  // lien : elle porte l'IDENTIFIANT de la fiche entreprise, son nom n'apparaît
  // qu'au rendu de la cellule. Taper « frai » ne pouvait donc pas trouver
  // « Fraisière du Nord-Est ». On recopie les noms visés dans un champ caché,
  // cherchable. Aucun nom de colonne codé en dur (les champs des retours se
  // pilotent depuis /champs/retours) : une entreprise se reconnaît à son
  // identifiant, quel que soit le champ qui le porte.
  const companies = useTable('companies')
  const companyNameByKey = useMemo(() => {
    const m = new Map()
    for (const c of companies) {
      if (!c?.name) continue
      if (c.id) m.set(c.id, c.name)
      if (c.airtable_id) m.set(c.airtable_id, c.name)
    }
    return m
  }, [companies])

  const rows = useMemo(() => {
    if (!companyNameByKey.size) return retours
    return retours.map(row => {
      let names = null
      for (const value of Object.values(row)) {
        // Un identifiant (rec Airtable ou id Boréal) tient en moins de 40
        // caractères ; une cellule de lien multiple les joint par « , ».
        if (typeof value !== 'string' || !value || value.length > 400) continue
        for (const key of value.split(',')) {
          const name = companyNameByKey.get(key.trim())
          if (!name) continue
          if (!names) names = []
          if (!names.includes(name)) names.push(name)
        }
      }
      return names ? { ...row, company_search: names.join(' ') } : row
    })
  }, [retours, companyNameByKey])

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
        showFormulaSyntaxHelp={false}
        showFormulaAutocompleteHint={false}
        showFormulaKeyboardHint={false}
        manageViews
        columns={COLUMNS}
        data={rows}
        loading={loading}
        onCellEdit={updateField}
        peek={{
          title: row => row.cf_de_retour || 'Retour',
          to: row => `/retours/${row.id}`,
          width: 720,
          openId: peekOpenId,
          onOpenConsumed: consumePeekOpen,
          render: (row, { close }) => <RetourDetail recordId={row.id} embedded onClose={close} />,
        }}
        // N° RMA (champ Airtable, déjà titre du panneau), identifiant, et nom
        // de l'entreprise reconstitué ci-dessus.
        searchFields={['cf_de_retour', 'id', 'company_search']}
        emptyState={{ icon: Undo2, title: 'Aucun retour', description: "Aucune demande de retour (RMA) n'a été enregistrée. Les retours clients apparaissent ici." }}
      />
    </ListPage>
  )
}
