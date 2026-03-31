import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { Plus, CheckCircle2, Circle, Clock, AlertCircle, X, Save } from 'lucide-react'
import { api } from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { Badge } from '../components/Badge.jsx'
import { Modal } from '../components/Modal.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TableConfigModal } from '../components/TableConfigModal.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'

function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('fr-CA', { year: 'numeric', month: 'short', day: 'numeric' })
}

function statusColor(s) {
  if (s === 'Terminé') return 'green'
  if (s === 'En cours') return 'blue'
  if (s === 'Annulé') return 'gray'
  return 'slate'
}

function priorityColor(p) {
  if (p === 'Urgente') return 'red'
  if (p === 'Haute') return 'orange'
  if (p === 'Normal') return 'blue'
  return 'gray'
}

function StatusIcon({ status }) {
  if (status === 'Terminé') return <CheckCircle2 size={16} className="text-green-500" />
  if (status === 'En cours') return <Clock size={16} className="text-blue-500" />
  if (status === 'Annulé') return <X size={16} className="text-slate-400" />
  return <Circle size={16} className="text-slate-400" />
}

const STATUSES = ['À faire', 'En cours', 'Terminé', 'Annulé']
const PRIORITIES = ['Basse', 'Normal', 'Haute', 'Urgente']

const RENDERS = {
  title: (row) => (
    <div className="flex items-center gap-2">
      <StatusIcon status={row.status} />
      <span className={`text-sm font-medium ${row.status === 'Terminé' ? 'line-through text-slate-400' : 'text-slate-900'}`}>{row.title}</span>
    </div>
  ),
  status: (row) => <Badge color={statusColor(row.status)} size="sm">{row.status}</Badge>,
  priority: (row) => <Badge color={priorityColor(row.priority)} size="sm">{row.priority}</Badge>,
  due_date: (row) => {
    if (!row.due_date) return <span className="text-slate-400">—</span>
    const d = new Date(row.due_date)
    const today = new Date(); today.setHours(0,0,0,0)
    const overdue = row.status !== 'Terminé' && d < today
    return (
      <span className={overdue ? 'text-red-600 font-medium' : 'text-slate-700'}>
        {overdue && <AlertCircle size={12} className="inline mr-1" />}
        {fmtDate(row.due_date)}
      </span>
    )
  },
  company_name: (row) => row.company_id
    ? <Link to={`/companies/${row.company_id}`} onClick={e => e.stopPropagation()} className="text-indigo-600 hover:underline text-sm">{row.company_name}</Link>
    : <span className="text-slate-400">—</span>,
  contact_name: (row) => row.contact_id
    ? <Link to={`/contacts/${row.contact_id}`} onClick={e => e.stopPropagation()} className="text-indigo-600 hover:underline text-sm">{row.contact_name}</Link>
    : <span className="text-slate-400">—</span>,
  assigned_name: (row) => row.assigned_name || <span className="text-slate-400">—</span>,
  created_at: (row) => fmtDate(row.created_at),
}

const COLUMNS = TABLE_COLUMN_META.tasks.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

function TaskForm({ initial = {}, companies = [], contacts = [], users = [], onSave, onClose }) {
  const [form, setForm] = useState({
    title: '', description: '', status: 'À faire', priority: 'Normal',
    due_date: '', company_id: '', contact_id: '', assigned_to: '', notes: '',
    ...initial,
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    if (!form.title.trim()) return setError('Le titre est requis')
    setError('')
    setSaving(true)
    try {
      await onSave(form)
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const f = (k) => (e) => setForm(p => ({ ...p, [k]: e.target.value }))

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="label">Titre *</label>
        <input value={form.title} onChange={f('title')} className="input" placeholder="Titre de la tâche" autoFocus />
      </div>
      <div>
        <label className="label">Description</label>
        <textarea value={form.description} onChange={f('description')} className="input" rows={2} placeholder="Optionnel" />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Statut</label>
          <select value={form.status} onChange={f('status')} className="select">
            {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Priorité</label>
          <select value={form.priority} onChange={f('priority')} className="select">
            {PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
      </div>
      <div>
        <label className="label">Date d'échéance</label>
        <input type="date" value={form.due_date || ''} onChange={f('due_date')} className="input" />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Entreprise</label>
          <select value={form.company_id || ''} onChange={f('company_id')} className="select">
            <option value="">—</option>
            {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Contact</label>
          <select value={form.contact_id || ''} onChange={f('contact_id')} className="select">
            <option value="">—</option>
            {contacts.map(c => <option key={c.id} value={c.id}>{c.first_name} {c.last_name}</option>)}
          </select>
        </div>
      </div>
      <div>
        <label className="label">Responsable</label>
        <select value={form.assigned_to || ''} onChange={f('assigned_to')} className="select">
          <option value="">—</option>
          {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
      </div>
      <div>
        <label className="label">Notes</label>
        <textarea value={form.notes || ''} onChange={f('notes')} className="input" rows={2} />
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onClose} className="btn-secondary"><X size={14} /> Annuler</button>
        <button type="submit" disabled={saving} className="btn-primary"><Save size={14} /> {saving ? 'Enregistrement...' : 'Enregistrer'}</button>
      </div>
    </form>
  )
}

export default function Tasks() {
  const [tasks, setTasks] = useState([])
  const [companies, setCompanies] = useState([])
  const [contacts, setContacts] = useState([])
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.tasks.list({ limit: 'all' })
      setTasks(data.data || [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    Promise.all([
      api.companies.list({ limit: 'all' }),
      api.contacts.list({ limit: 'all' }),
      api.auth.users(),
    ]).then(([c, ct, u]) => {
      setCompanies(c.data || [])
      setContacts(ct.data || [])
      setUsers(u || [])
    }).catch(() => {})
  }, [])

  async function handleCreate(form) {
    await api.tasks.create(form)
    await load()
  }

  async function handleEdit(form) {
    await api.tasks.update(editing.id, form)
    await load()
    setEditing(null)
  }

  async function handleDelete(row) {
    if (!confirm(`Supprimer la tâche « ${row.title} » ?`)) return
    await api.tasks.delete(row.id)
    await load()
  }

  return (
    <Layout>
      <div className="p-6 max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Tâches</h1>
            <p className="text-sm text-slate-500 mt-0.5">{tasks.length} tâche{tasks.length !== 1 ? 's' : ''}</p>
          </div>
          <div className="flex items-center gap-2">
            <TableConfigModal table="tasks" />
            <button onClick={() => setShowModal(true)} className="btn-primary">
              <Plus size={16} /> Nouvelle tâche
            </button>
          </div>
        </div>

        <DataTable
          table="tasks"
          columns={COLUMNS}
          data={tasks}
          loading={loading}
          onRowClick={(row) => setEditing(row)}
          searchFields={['title', 'company_name', 'contact_name']}
        />
      </div>

      {showModal && (
        <Modal title="Nouvelle tâche" onClose={() => setShowModal(false)}>
          <TaskForm
            companies={companies}
            contacts={contacts}
            users={users}
            onSave={handleCreate}
            onClose={() => setShowModal(false)}
          />
        </Modal>
      )}

      {editing && (
        <Modal title="Modifier la tâche" onClose={() => setEditing(null)}>
          <TaskForm
            initial={editing}
            companies={companies}
            contacts={contacts}
            users={users}
            onSave={handleEdit}
            onClose={() => setEditing(null)}
          />
          <div className="flex justify-start pt-2 border-t border-slate-200 mt-2">
            <button
              onClick={() => handleDelete(editing)}
              className="text-sm text-red-500 hover:text-red-700 hover:underline"
            >
              Supprimer cette tâche
            </button>
          </div>
        </Modal>
      )}
    </Layout>
  )
}
