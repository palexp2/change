import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { Plus, CheckCircle2, Circle, Clock, AlertCircle, X } from 'lucide-react'
import { api } from '../lib/api.js'
import { useAuth } from '../lib/auth.jsx'
import { Layout } from '../components/Layout.jsx'
import { Badge } from '../components/Badge.jsx'
import { Modal } from '../components/Modal.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TableConfigModal } from '../components/TableConfigModal.jsx'
import TaskForm from '../components/TaskForm.jsx'
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
    ? <Link to={`/companies/${row.company_id}`} onClick={e => e.stopPropagation()} className="text-brand-600 hover:underline text-sm">{row.company_name}</Link>
    : <span className="text-slate-400">—</span>,
  contact_name: (row) => row.contact_id
    ? <Link to={`/contacts/${row.contact_id}`} onClick={e => e.stopPropagation()} className="text-brand-600 hover:underline text-sm">{row.contact_name}</Link>
    : <span className="text-slate-400">—</span>,
  ticket_title: (row) => row.ticket_id
    ? <Link to={`/tickets/${row.ticket_id}`} onClick={e => e.stopPropagation()} className="text-brand-600 hover:underline text-sm">{row.ticket_title}</Link>
    : <span className="text-slate-400">—</span>,
  assigned_name: (row) => row.assigned_name || <span className="text-slate-400">—</span>,
  created_at: (row) => fmtDate(row.created_at),
}

const COLUMNS = TABLE_COLUMN_META.tasks.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

export default function Tasks() {
  const { user } = useAuth()
  const [tasks, setTasks] = useState([])
  const [companies, setCompanies] = useState([])
  const [contacts, setContacts] = useState([])
  const [users, setUsers] = useState([])
  const [tickets, setTickets] = useState([])
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
    api.tickets.list({ limit: 'all' }).then(r => setTickets(r.data || [])).catch(() => {})
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
      <div className="p-6">
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
          tickets={tickets}
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
            tickets={tickets}
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
