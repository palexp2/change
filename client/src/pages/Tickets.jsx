import { Plus, LifeBuoy } from 'lucide-react'
import api from '../lib/api.js'
import { useListData } from '../lib/useListData.js'
import { ListPage } from '../components/ListPage.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { RatingStars } from '../components/RatingStars.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import TicketDetail from './TicketDetail.jsx'

// Titre, question, réponse, type, statut, durée, date, entreprise et contact ont
// été droppés (migration 040) : les colonnes d'un billet viennent maintenant de
// ses champs personnalisés, réglés depuis /champs/tickets.
const RENDERS = {
  // Sondage envoyé mais sans réponse : un tiret plutôt que rien, pour
  // distinguer « en attente » de « jamais sollicité » (colonne vide).
  survey_rating: row => {
    if (!row.survey_rating) return row.survey_sent_at ? <span className="text-slate-300 text-sm">—</span> : null
    return <RatingStars value={row.survey_rating} />
  },
}

const COLUMNS = TABLE_COLUMN_META.tickets.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

// Champs proposés par le formulaire « Nouveau billet ». Les champs de la table
// arrivent du catalogue du registre via `includeAllFields`, et POST /api/tickets
// sait les persister (voir RecordForm.jsx pour la configuration).
//
// « Assigné à » n'est plus déclaré ici : le champ codé en dur (`assigned_to`,
// FK vers `users`) doublait celui de /champs/tickets et a été droppé (migration
// 048). Le survivant vient du catalogue comme les autres — posable dans le
// formulaire dès que son sens de sync cesse d'être « import » seul.
//
// L'entreprise et le contact du billet sont déclarés ici : ce sont des champs
// lien du registre, posés visibles d'emblée (`catalog: true` = la page ne fait
// que régler leur affichage, leur nature vient du registre). Ce sont les
// colonnes que le write-back nomme déjà (WRITEBACK_MODULES.billets.linkColumns)
// : un billet ouvert ici arrive ainsi dans Airtable rattaché à la fiche du
// client. Supprimer l'un des deux le retire du formulaire, sans rien casser.
const FORM_FIELDS = [
  { field: 'cf_entreprise', catalog: true, visible: true },
  { field: 'cf_contact', catalog: true, visible: true },
]

export default function Tickets() {
  const { rows: tickets, loading, reload } = useListData({ table: 'tickets' })

  async function handleCreate(form) { await api.tickets.create(form); await reload() }

  return (
    <ListPage
      title="Billets"
      create={{ label: 'Nouveau billet', table: 'tickets', fields: FORM_FIELDS, includeAllFields: true, columns: 2, size: 'lg', onSubmit: handleCreate }}
    >
      {({ openCreate }) => (
        <DataTable
          table="tickets"
          manageViews
          columns={COLUMNS}
          data={tickets}
          loading={loading}
          peek={{
            title: row => row.cf_billet || 'Billet',
            to: row => `/tickets/${row.id}`,
            width: 720,
            render: (row, { close }) => <TicketDetail recordId={row.id} embedded onClose={close} />,
          }}
          searchFields={['assigned_name']}
          emptyState={{ icon: LifeBuoy, title: 'Aucun billet', description: "Aucune demande de support n'est ouverte. Crée un billet pour suivre une demande client.", cta: { label: 'Nouveau billet', icon: Plus, onClick: openCreate } }}
        />
      )}
    </ListPage>
  )
}
