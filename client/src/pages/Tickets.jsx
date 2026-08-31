import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Plus, LifeBuoy, Star } from 'lucide-react'
import api from '../lib/api.js'
import { useAuth } from '../lib/auth.jsx'
import { useTable, isTableHydrated } from '../lib/dataStore.js'
import { sync as syncStore } from '../lib/dataSync.js'
import { Layout } from '../components/Layout.jsx'
import { PageTitle } from '../components/PageTitle.jsx'
import { Badge, ticketStatusColor } from '../components/Badge.jsx'
import { Modal } from '../components/Modal.jsx'
import { DataTable } from '../components/DataTable.jsx'
import LinkedRecordField from '../components/LinkedRecordField.jsx'
import { SearchableSelect } from '../components/SearchableSelect.jsx'
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

function TicketForm({ initial = {}, meta = {}, companies = [], users = [], contacts = [], defaultAssignedTo = '', onSave, onClose }) {
  const [form, setForm] = useState({
    title: '', company_id: '', contact_id: '', assigned_to: defaultAssignedTo,
    type: '', status: 'Waiting on us', description: '', duration_minutes: 0,
    ...initial
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setSaving(true)
    try { await onSave(form); onClose() }
    catch (err) { setError(err.message) }
    finally { setSaving(false) }
  }

  const filteredContacts = contactsForCompany(contacts, form.company_id)

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="label">Titre</label>
        <input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} className="input" />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Type</label>
          <SearchableSelect
            value={form.type}
            options={(meta.types || []).map(t => ({ value: t, label: t }))}
            emptyOption="—"
            placeholder="—"
            onChange={v => setForm(f => ({ ...f, type: v }))}
            className="input"
            size="sm"
            testId="ticket-form-type"
          />
        </div>
        <div>
          <label className="label">Statut</label>
          <SearchableSelect
            value={form.status}
            options={(meta.statuses || []).map(s => ({ value: s, label: s }))}
            emptyOption="—"
            placeholder="—"
            onChange={v => setForm(f => ({ ...f, status: v }))}
            className="input"
            size="sm"
            testId="ticket-form-status"
          />
        </div>
        <div>
          <label className="label">Entreprise</label>
          <LinkedRecordField
            name="ticket_company_id"
            value={form.company_id}
            options={companies}
            labelFn={c => c.name}
            placeholder="Entreprise"
            onChange={v => setForm(f => ({ ...f, company_id: v, contact_id: '' }))}
          />
        </div>
        <div>
          <label className="label">Contact</label>
          <LinkedRecordField
            name="ticket_contact_id"
            value={form.contact_id}
            options={filteredContacts}
            labelFn={c => `${c.first_name || ''} ${c.last_name || ''}`.trim()}
            placeholder="Contact"
            onChange={v => setForm(f => ({ ...f, contact_id: v }))}
          />
        </div>
        <div>
          <label className="label">Assigne a</label>
          <LinkedRecordField
            name="ticket_assigned_to"
            value={form.assigned_to}
            options={users}
            labelFn={u => u.name}
            placeholder="Assigner"
            onChange={v => setForm(f => ({ ...f, assigned_to: v }))}
          />
        </div>
        <div>
          <label className="label">Duree (minutes)</label>
          <input type="number" min="0" value={form.duration_minutes} onChange={e => setForm(f => ({ ...f, duration_minutes: e.target.value }))} className="input" />
        </div>
      </div>
      <div>
        <label className="label">Question</label>
        <textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} className="input" rows={3} />
      </div>
      {error && <p className="text-red-600 text-sm">{error}</p>}
      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onClose} className="btn-secondary">Annuler</button>
        <button type="submit" disabled={saving} className="btn-primary">{saving ? 'Enregistrement...' : 'Enregistrer'}</button>
      </div>
    </form>
  )
}

export default function Tickets() {
  const { user } = useAuth()
  const [meta, setMeta] = useState({ types: [], statuses: [] })
  const [showModal, setShowModal] = useState(false)

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

  useEffect(() => {
    api.tickets.meta().then(setMeta).catch(() => {})
  }, [])

  async function handleCreate(form) { await api.tickets.create(form); await syncStore() }

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

        <DataTable
          table="tickets"
          manageViews
          columns={COLUMNS}
          data={tickets}
          loading={loading}
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
        <TicketForm meta={meta} companies={companies} contacts={contacts} users={users} defaultAssignedTo={user?.id || ''} onSave={handleCreate} onClose={() => setShowModal(false)} />
      </Modal>

    </Layout>
  )
}
