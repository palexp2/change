import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { Plus, CheckCircle2, Circle, Clock, AlertCircle, X, Save, Trash2 } from 'lucide-react'
import { api } from '../lib/api.js'
import { useAuth } from '../lib/auth.jsx'
import { Layout } from '../components/Layout.jsx'
import { Badge } from '../components/Badge.jsx'
import { Modal } from '../components/Modal.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TableConfigModal } from '../components/TableConfigModal.jsx'
import LinkedRecordField from '../components/LinkedRecordField.jsx'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { useUndoableDelete } from '../lib/undoableDelete.js'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'


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
const TYPES = ['Problème']

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

function parseKeywords(v) {
  if (Array.isArray(v)) return v
  if (typeof v === 'string' && v.trim()) { try { const p = JSON.parse(v); return Array.isArray(p) ? p : [] } catch { return [] } }
  return []
}

function KeywordPicker({ value, onChange }) {
  const [catalog, setCatalog] = useState([])
  const [open, setOpen] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const confirm = useConfirm()

  const load = useCallback(() => {
    api.tasks.keywords.list().then(r => setCatalog(r.data || [])).catch(() => {})
  }, [])
  useEffect(() => { load() }, [load])

  function toggle(id) {
    onChange(value.includes(id) ? value.filter(v => v !== id) : [...value, id])
  }

  async function handleCreate(e) {
    e.preventDefault()
    if (!newLabel.trim()) return
    const created = await api.tasks.keywords.create({ label: newLabel.trim() })
    setNewLabel('')
    setCatalog(c => c.some(k => k.id === created.id) ? c : [...c, created].sort((a, b) => a.label.localeCompare(b.label)))
    if (!value.includes(created.id)) onChange([...value, created.id])
  }

  async function handleDelete(id) {
    if (!(await confirm('Supprimer ce mot-clé du catalogue ?'))) return
    await api.tasks.keywords.delete(id)
    setCatalog(c => c.filter(k => k.id !== id))
    if (value.includes(id)) onChange(value.filter(v => v !== id))
  }

  const selectedLabels = value.map(id => catalog.find(k => k.id === id)).filter(Boolean)

  return (
    <div>
      <label className="label">Mots-clés</label>
      <div className="relative">
        <button type="button" onClick={() => setOpen(o => !o)} className="input text-left flex flex-wrap gap-1 min-h-[38px] items-center">
          {selectedLabels.length === 0 && <span className="text-slate-400">Choisir…</span>}
          {selectedLabels.map(k => (
            <span key={k.id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 text-xs">{k.label}</span>
          ))}
        </button>
        {open && (
          <div className="absolute z-10 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg max-h-60 overflow-y-auto">
            {catalog.length === 0 && <div className="px-3 py-2 text-sm text-slate-400">Aucun mot-clé. Ajoutez-en un ci-dessous.</div>}
            {catalog.map(k => (
              <div key={k.id} className="flex items-center justify-between px-3 py-1.5 hover:bg-slate-50">
                <label className="flex items-center gap-2 text-sm flex-1 cursor-pointer">
                  <input type="checkbox" checked={value.includes(k.id)} onChange={() => toggle(k.id)} />
                  {k.label}
                </label>
                <button type="button" onClick={() => handleDelete(k.id)} className="text-slate-400 hover:text-red-500"><Trash2 size={14} /></button>
              </div>
            ))}
            <div className="flex gap-1 p-2 border-t border-slate-200">
              <input value={newLabel} onChange={e => setNewLabel(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleCreate(e)} className="input flex-1 text-sm" placeholder="Nouveau mot-clé…" />
              <button type="button" onClick={handleCreate} className="btn-secondary px-2"><Plus size={14} /></button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function TaskForm({ initial = {}, companies = [], contacts = [], users = [], defaultAssignedTo = '', onSave, onClose }) {
  const [form, setForm] = useState({
    title: '', description: '', status: 'À faire', priority: 'Normal', type: '',
    due_date: '', company_id: '', contact_id: '', notes: '',
    ...initial,
    type: initial.type || '',
    assigned_to: initial.id ? (initial.assigned_to || '') : (defaultAssignedTo || ''),
    keywords: parseKeywords(initial.keywords),
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
  const setKey = (k) => (v) => setForm(p => ({ ...p, [k]: v }))

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
        <div>
          <label className="label">Type</label>
          <select value={form.type || ''} onChange={f('type')} className="select">
            <option value="">—</option>
            {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
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
          <LinkedRecordField
            name="task_company_id"
            value={form.company_id || ''}
            options={companies}
            labelFn={c => c.name}
            placeholder="Entreprise"
            onChange={setKey('company_id')}
          />
        </div>
        <div>
          <label className="label">Contact</label>
          <LinkedRecordField
            name="task_contact_id"
            value={form.contact_id || ''}
            options={contacts}
            labelFn={c => `${c.first_name || ''} ${c.last_name || ''}`.trim()}
            placeholder="Contact"
            onChange={setKey('contact_id')}
          />
        </div>
      </div>
      <div>
        <label className="label">Responsable</label>
        <LinkedRecordField
          name="task_assigned_to"
          value={form.assigned_to || ''}
          options={users}
          labelFn={u => u.name}
          placeholder="Responsable"
          onChange={setKey('assigned_to')}
        />
      </div>
      <KeywordPicker value={form.keywords} onChange={(kw) => setForm(p => ({ ...p, keywords: kw }))} />
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
  const { user } = useAuth()
  const [tasks, setTasks] = useState([])
  const [companies, setCompanies] = useState([])
  const [contacts, setContacts] = useState([])
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState(null)
  const undoableDelete = useUndoableDelete()

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
    api.auth.users().then(u => setUsers(u || [])).catch(() => {})
    api.companies.lookup().then(setCompanies).catch(() => {})
    api.contacts.lookup().then(setContacts).catch(() => {})
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
    setEditing(null)
    await undoableDelete({
      table: 'tasks',
      id: row.id,
      deleteFn: () => api.tasks.delete(row.id),
      label: 'Tâche supprimée',
      onChange: load,
    })
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
          onBulkDelete={async (ids) => {
            await undoableDelete({
              table: 'tasks',
              ids,
              deleteFn: () => Promise.all(ids.map(id => api.tasks.delete(id))),
              label: `${ids.length} tâche${ids.length > 1 ? 's' : ''} supprimée${ids.length > 1 ? 's' : ''}`,
              onChange: load,
            })
          }}
        />
      </div>

      <Modal isOpen={showModal} title="Nouvelle tâche" onClose={() => setShowModal(false)}>
        <TaskForm
          companies={companies}
          contacts={contacts}
          users={users}
          defaultAssignedTo={user?.id || ''}
          onSave={handleCreate}
          onClose={() => setShowModal(false)}
        />
      </Modal>

      {editing && (
        <Modal isOpen={!!editing} title="Modifier la tâche" onClose={() => setEditing(null)}>
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
