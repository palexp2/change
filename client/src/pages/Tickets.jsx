import { useState, useEffect, useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Plus, LifeBuoy, Star, X } from 'lucide-react'
import api from '../lib/api.js'
import { useAuth } from '../lib/auth.jsx'
import { useTable, isTableHydrated } from '../lib/dataStore.js'
import { sync as syncStore } from '../lib/dataSync.js'
import { Layout } from '../components/Layout.jsx'
import { PageTitle } from '../components/PageTitle.jsx'
import { Badge, ticketStatusColor } from '../components/Badge.jsx'
import { Modal } from '../components/Modal.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { RecordForm } from '../components/RecordForm.jsx'
import LinkedRecordField from '../components/LinkedRecordField.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'
import { contactsForCompany } from '../lib/contactCompanies'
import TicketDetail from './TicketDetail.jsx'

import { fmtDurationMinutes as fmtDuration } from '../lib/duration.js'

const RENDERS = {
  title: row => <div className="font-medium text-slate-900">{row.title}</div>,
  contact_name: row => {
    if (!row.contact_name) return null
    return row.contact_id
      ? <Link to={`/contacts/${row.contact_id}`} onClick={e => e.stopPropagation()} className="text-brand-600 hover:underline">{row.contact_name}</Link>
      : <span className="text-slate-400">{row.contact_name}</span>
  },
  status: row => <Badge color={ticketStatusColor(row.status)}>{row.status}</Badge>,
  type: row => row.type ? <Badge color="gray">{row.type}</Badge> : null,
  duration_minutes: row => <span className="text-slate-500">{fmtDuration(row.duration_minutes)}</span>,
  created_at: row => row.created_at ? <span className="text-slate-500 text-sm">{fmtDate(row.created_at)}</span> : null,
  // Sondage envoyé mais sans réponse : un tiret plutôt que rien, pour
  // distinguer « en attente » de « jamais sollicité » (colonne vide).
  survey_rating: row => {
    if (!row.survey_rating) return row.survey_sent_at ? <span className="text-slate-300 text-sm">—</span> : null
    return (
      <span className="inline-flex items-center gap-1 text-sm" title={`${row.survey_rating}/5`}>
        <Star size={13} className="text-amber-400" fill="currentColor" strokeWidth={1.5} />
        <span className="text-slate-700 tabular-nums">{row.survey_rating}</span>
      </span>
    )
  },
}

const COLUMNS = TABLE_COLUMN_META.tickets.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

// Champs proposés par le formulaire « Nouveau billet » — liste calquée sur ce
// que POST /api/tickets persiste (voir RecordForm.jsx pour la configuration).
function ticketFormFields({ meta, companies, contacts, users, defaultAssignedTo }) {
  return [
    { field: 'title', label: 'Titre', span: 2 },
    { field: 'type', label: 'Type', type: 'select', options: meta.types || [], searchable: true, testId: 'ticket-form-type' },
    { field: 'status', label: 'Statut', type: 'select', options: meta.statuses || [], defaultValue: 'Waiting on us', searchable: true, testId: 'ticket-form-status' },
    {
      field: 'company_id', label: 'Entreprise',
      input: ({ value, setValues }) => (
        <LinkedRecordField
          name="ticket_company_id"
          value={value}
          options={companies}
          labelFn={c => c.name}
          // Changer d'entreprise invalide le contact déjà choisi (il n'appartient
          // plus forcément à la nouvelle entreprise).
          onChange={v => setValues(f => ({ ...f, company_id: v, contact_id: '' }))}
        />
      ),
    },
    {
      field: 'contact_id', label: 'Contact',
      input: ({ value, onChange, values }) => (
        <LinkedRecordField
          name="ticket_contact_id"
          value={value}
          options={contactsForCompany(contacts, values.company_id)}
          labelFn={c => `${c.first_name || ''} ${c.last_name || ''}`.trim()}
          onChange={onChange}
        />
      ),
    },
    {
      field: 'assigned_to', label: 'Assigné à', defaultValue: defaultAssignedTo,
      input: ({ value, onChange }) => (
        <LinkedRecordField
          name="ticket_assigned_to"
          value={value}
          options={users}
          labelFn={u => u.name}
          onChange={onChange}
        />
      ),
    },
    { field: 'duration_minutes', label: 'Durée (minutes)', type: 'number', min: '0', defaultValue: 0 },
    { field: 'description', label: 'Question', type: 'textarea', span: 2 },
    // Masqué par défaut — disponible via « Modifier le formulaire ».
    { field: 'response', label: 'Réponse', type: 'textarea', span: 2, visible: false },
  ]
}

export default function Tickets() {
  const { user } = useAuth()
  const [meta, setMeta] = useState({ types: [], statuses: [] })
  const [showModal, setShowModal] = useState(false)
  const [searchParams, setSearchParams] = useSearchParams()
  // Filtre temporaire posé par un clic sur une barre du graphique « Billets de
  // support » (vue globale du dashboard) : 'YYYY-MM'.
  const createdMonth = searchParams.get('createdMonth')

  const ticketsRaw = useTable('tickets')
  const companies = useTable('companies')
  const contacts = useTable('contacts')
  const users = useTable('users')
  const loading = !isTableHydrated('tickets')

  const tickets = useMemo(() => {
    const cById = new Map(companies.map(c => [c.id, c.name]))
    const ctById = new Map(contacts.map(c => [c.id, `${c.first_name || ''} ${c.last_name || ''}`.trim()]))
    const uById = new Map(users.map(u => [u.id, u.name]))
    return ticketsRaw.map(r => ({
      ...r,
      company_name: cById.get(r.company_id) || r.company_name,
      contact_name: ctById.get(r.contact_id) || r.contact_name,
      assigned_name: uById.get(r.assigned_to) || r.assigned_name,
    }))
  }, [ticketsRaw, companies, contacts, users])

  // Même bucketing que le graphique du dashboard : mois UTC de `created_at`.
  const displayedTickets = useMemo(() => {
    if (!createdMonth) return tickets
    return tickets.filter(t => String(t.created_at || '').slice(0, 7) === createdMonth)
  }, [tickets, createdMonth])

  useEffect(() => {
    api.tickets.meta().then(setMeta).catch(() => {})
  }, [])

  async function handleCreate(form) { await api.tickets.create(form); await syncStore() }

  const formFields = useMemo(
    () => ticketFormFields({ meta, companies, contacts, users, defaultAssignedTo: user?.id || '' }),
    [meta, companies, contacts, users, user?.id],
  )

  return (
    <Layout>
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <PageTitle>Billets</PageTitle>
          <div className="flex items-center gap-2">
            <button onClick={() => setShowModal(true)} className="btn-primary">
              <Plus size={16} /> Nouveau billet
            </button>
          </div>
        </div>

        {createdMonth && (
          <div className="flex items-center gap-2 mb-3 px-3 py-2 bg-brand-50 border border-brand-200 rounded-lg text-sm text-brand-700" data-testid="tickets-created-month-filter">
            <span>
              Billets créés en {new Date(`${createdMonth}-15T12:00:00Z`).toLocaleDateString('fr-CA', { month: 'long', year: 'numeric', timeZone: 'UTC' })}
              {' '}({displayedTickets.length})
            </span>
            <button
              onClick={() => setSearchParams({})}
              className="ml-auto flex items-center gap-1 text-xs text-brand-500 hover:text-brand-700"
              data-testid="tickets-created-month-clear"
            >
              <X size={13} /> Effacer
            </button>
          </div>
        )}

        <DataTable
          table="tickets"
          manageViews
          columns={COLUMNS}
          data={displayedTickets}
          loading={loading}
          forceAllView={!!createdMonth}
          peek={{
            title: row => row.title || 'Billet',
            subtitle: row => row.company_name || row.contact_name || '',
            to: row => `/tickets/${row.id}`,
            width: 720,
            render: (row, { close }) => <TicketDetail recordId={row.id} embedded onClose={close} />,
          }}
          searchFields={['title', 'company_name', 'contact_name', 'assigned_name']}
          emptyState={{ icon: LifeBuoy, title: 'Aucun ticket', description: "Aucune demande de support n'est ouverte. Crée un ticket pour suivre une demande client.", cta: { label: 'Nouveau ticket', icon: Plus, onClick: () => setShowModal(true) } }}
        />
      </div>

      <Modal isOpen={showModal} onClose={() => setShowModal(false)} title="Nouveau billet" size="lg">
        <RecordForm
          table="tickets"
          fields={formFields}
          columns={2}
          onSubmit={handleCreate}
          onClose={() => setShowModal(false)}
        />
      </Modal>

    </Layout>
  )
}
