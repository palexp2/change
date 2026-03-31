import { useState, useEffect, useCallback } from 'react'
import { Plus } from 'lucide-react'
import api from '../lib/api.js'
import { loadProgressive } from '../lib/loadAll.js'
import { Layout } from '../components/Layout.jsx'
import { Badge, ticketStatusColor } from '../components/Badge.jsx'
import { Modal } from '../components/Modal.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TableConfigModal } from '../components/TableConfigModal.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'

const typeColors = {
  'Aide software': 'blue', 'Defect software': 'red', 'Aide hardware': 'indigo',
  'Defect hardware': 'red', 'Erreur de commande': 'orange', 'Formation': 'green', 'Installation': 'teal',
}

function fmtDuration(mins) {
  if (!mins) return '—'
  const h = Math.floor(mins / 60), m = mins % 60
  return h === 0 ? `${m}m` : `${h}h${m > 0 ? m + 'm' : ''}`
}

const TICKET_TYPES = ['Aide software', 'Defect software', 'Aide hardware', 'Defect hardware', 'Erreur de commande', 'Formation', 'Installation']
const STATUSES = ['Waiting on us', 'Waiting on them', 'Closed']

const RENDERS = {
  title: row => (
    <div>
      <div className="font-medium text-slate-900">{row.title}</div>
      {row.contact_name && <div className="text-xs text-slate-400">{row.contact_name}</div>}
    </div>
  ),
  status: row => <Badge color={ticketStatusColor(row.status)}>{row.status}</Badge>,
  type: row => row.type ? <Badge color={typeColors[row.type] || 'gray'}>{row.type}</Badge> : null,
  duration_minutes: row => <span className="text-slate-500">{fmtDuration(row.duration_minutes)}</span>,
  created_at: row => row.created_at ? <span className="text-slate-500 text-sm">{new Date(row.created_at).toLocaleDateString('fr-CA')}</span> : null,
}

const COLUMNS = TABLE_COLUMN_META.tickets.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

function TicketForm({ initial = {}, companies = [], users = [], contacts = [], onSave, onClose }) {
  const [form, setForm] = useState({
    title: '', company_id: '', contact_id: '', assigned_to: '',
    type: '', status: 'Waiting on us', description: '', duration_minutes: 0, notes: '',
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
        <label className="label">Titre *</label>
        <input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} className="input" required />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Type</label>
          <select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))} className="select">
            <option value="">—</option>
            {TICKET_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Statut</label>
          <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))} className="select">
            {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Entreprise</label>
          <select value={form.company_id} onChange={e => setForm(f => ({ ...f, company_id: e.target.value, contact_id: '' }))} className="select">
            <option value="">—</option>
            {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Contact</label>
          <select value={form.contact_id} onChange={e => setForm(f => ({ ...f, contact_id: e.target.value }))} className="select">
            <option value="">—</option>
            {filteredContacts.map(c => <option key={c.id} value={c.id}>{c.first_name} {c.last_name}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Assigné à</label>
          <select value={form.assigned_to} onChange={e => setForm(f => ({ ...f, assigned_to: e.target.value }))} className="select">
            <option value="">—</option>
            {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Durée (minutes)</label>
          <input type="number" min="0" value={form.duration_minutes} onChange={e => setForm(f => ({ ...f, duration_minutes: e.target.value }))} className="input" />
        </div>
      </div>
      <div>
        <label className="label">Description</label>
        <textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} className="input" rows={3} />
      </div>
      <div>
        <label className="label">Notes internes</label>
        <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} className="input" rows={2} />
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
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editTicket, setEditTicket] = useState(null)

  const load = useCallback(async () => {
    await loadProgressive(
      (page, limit) => api.tickets.list({ limit, page }),
      setTickets, setLoading
    )
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    api.companies.list({ limit: 'all' }).then(r => setCompanies(r.data)).catch(() => {})
    api.contacts.list({ limit: 'all' }).then(r => setContacts(r.data)).catch(() => {})
    api.admin.listUsers().then(setUsers).catch(() => {})
  }, [])

  async function handleCreate(form) { await api.tickets.create(form); load() }
  async function handleUpdate(form) { await api.tickets.update(editTicket.id, form); setEditTicket(null); load() }

  return (
    <Layout>
      <div className="p-6 max-w-7xl mx-auto">
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
          onRowClick={setEditTicket}
          searchFields={['title', 'company_name']}
        />
      </div>

      <Modal isOpen={showModal} onClose={() => setShowModal(false)} title="Nouveau billet" size="lg">
        <TicketForm companies={companies} contacts={contacts} users={users} onSave={handleCreate} onClose={() => setShowModal(false)} />
      </Modal>

      <Modal isOpen={!!editTicket} onClose={() => setEditTicket(null)} title="Modifier le billet" size="lg">
        {editTicket && (
          <TicketForm initial={editTicket} companies={companies} contacts={contacts} users={users} onSave={handleUpdate} onClose={() => setEditTicket(null)} />
        )}
      </Modal>
    </Layout>
  )
}
