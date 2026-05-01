import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus } from 'lucide-react'
import api from '../lib/api.js'
import { loadProgressive } from '../lib/loadAll.js'
import { Layout } from '../components/Layout.jsx'
import { Badge, ticketStatusColor } from '../components/Badge.jsx'
import { Modal } from '../components/Modal.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TableConfigModal } from '../components/TableConfigModal.jsx'
import LinkedRecordField from '../components/LinkedRecordField.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'

function fmtDuration(mins) {
  if (!mins) return '—'
  const h = Math.floor(mins / 60), m = mins % 60
  return h === 0 ? `${m}m` : `${h}h${m > 0 ? m + 'm' : ''}`
}

const RENDERS = {
  title: row => (
    <div>
      <div className="font-medium text-slate-900">{row.title}</div>
      {row.contact_name && <div className="text-xs text-slate-400">{row.contact_name}</div>}
    </div>
  ),
  status: row => <Badge color={ticketStatusColor(row.status)}>{row.status}</Badge>,
  type: row => row.type ? <Badge color="gray">{row.type}</Badge> : null,
  duration_minutes: row => <span className="text-slate-500">{fmtDuration(row.duration_minutes)}</span>,
  created_at: row => row.created_at ? <span className="text-slate-500 text-sm">{new Date(row.created_at).toLocaleDateString('fr-CA')}</span> : null,
}

const COLUMNS = TABLE_COLUMN_META.tickets.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

function TicketForm({ initial = {}, meta = {}, companies = [], users = [], contacts = [], onSave, onClose }) {
  const [form, setForm] = useState({
    title: '', company_id: '', contact_id: '', assigned_to: '',
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

  const filteredContacts = form.company_id ? contacts.filter(c => c.company_id === form.company_id) : contacts

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="label">Titre</label>
        <input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} className="input" />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Type</label>
          <select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))} className="select">
            <option value="">—</option>
            {(meta.types || []).map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Statut</label>
          <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))} className="select">
            <option value="">—</option>
            {(meta.statuses || []).map(s => <option key={s} value={s}>{s}</option>)}
          </select>
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
  const [tickets, setTickets] = useState([])
  const [companies, setCompanies] = useState([])
  const [contacts, setContacts] = useState([])
  const [users, setUsers] = useState([])
  const [meta, setMeta] = useState({ types: [], statuses: [] })
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const navigate = useNavigate()

  const load = useCallback(async () => {
    await loadProgressive(
      (page, limit) => api.tickets.list({ limit, page }),
      setTickets, setLoading
    )
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    api.companies.lookup().then(setCompanies).catch(() => {})
    api.contacts.lookup().then(setContacts).catch(() => {})
    api.admin.listUsers().then(setUsers).catch(() => {})
    api.tickets.meta().then(setMeta).catch(() => {})
  }, [])

  async function handleCreate(form) { await api.tickets.create(form); load() }

  return (
    <Layout>
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Billets</h1>
          </div>
          <div className="flex items-center gap-2">
            <TableConfigModal table="tickets" />
            <button onClick={() => setShowModal(true)} className="btn-primary">
              <Plus size={16} /> Nouveau billet
            </button>
          </div>
        </div>

        <DataTable
          table="tickets"
          columns={COLUMNS}
          data={tickets}
          loading={loading}
          onRowClick={row => navigate(`/tickets/${row.id}`)}
          searchFields={['title', 'company_name']}
        />
      </div>

      <Modal isOpen={showModal} onClose={() => setShowModal(false)} title="Nouveau billet" size="lg">
        <TicketForm meta={meta} companies={companies} contacts={contacts} users={users} onSave={handleCreate} onClose={() => setShowModal(false)} />
      </Modal>

    </Layout>
  )
}
