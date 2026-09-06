import { useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { CheckCircle2, Circle, Clock, AlertCircle, X } from 'lucide-react'
import { api } from '../lib/api.js'
import { useAuth } from '../lib/auth.jsx'
import { useTable } from '../lib/dataStore.js'
import { useListData } from '../lib/useListData.js'
import { ListPage } from '../components/ListPage.jsx'
import { Badge } from '../components/Badge.jsx'
import RecordPeekDrawer from '../components/RecordPeekDrawer.jsx'
import { DataTable } from '../components/DataTable.jsx'
import TaskForm, { KeywordPicker } from '../components/TaskForm.jsx'
import LinkedRecordField from '../components/LinkedRecordField.jsx'
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
  assigned_name: (row) => row.assigned_employee_id
    ? <Link to={`/employees/${row.assigned_employee_id}`} onClick={e => e.stopPropagation()} className="text-brand-600 hover:underline text-sm">{row.assigned_name}</Link>
    : (row.assigned_name || <span className="text-slate-400">—</span>),
  created_at: (row) => fmtDate(row.created_at),
}

const COLUMNS = TABLE_COLUMN_META.tasks.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

// Champs proposés par le formulaire « Nouvelle tâche » — liste calquée sur ce
// que POST /api/tasks persiste (voir RecordForm.jsx pour la configuration).
function taskFormFields({ companies, contacts, users, tickets, defaultAssignedTo }) {
  const linked = (name, options, labelFn, href) => ({ value, onChange }) => (
    <LinkedRecordField
      name={name}
      value={value || ''}
      options={options}
      labelFn={labelFn}
      getHref={href}
      onChange={onChange}
    />
  )
  return [
    { field: 'title', label: 'Titre', span: 2, locked: true, required: true },
    { field: 'description', label: 'Description', type: 'textarea', rows: 2, span: 2 },
    { field: 'status', label: 'Statut', type: 'select', options: ['À faire', 'En cours', 'Terminé', 'Annulé'], defaultValue: 'À faire' },
    { field: 'priority', label: 'Priorité', type: 'select', options: ['Basse', 'Normal', 'Haute', 'Urgente'], defaultValue: 'Normal' },
    { field: 'type', label: 'Type', type: 'select', options: ['Problème'] },
    { field: 'due_date', label: "Date d'échéance", type: 'date' },
    { field: 'company_id', label: 'Entreprise', input: linked('task_company_id', companies, c => c.name, c => `/companies/${c.id}`) },
    { field: 'contact_id', label: 'Contact', input: linked('task_contact_id', contacts, c => `${c.first_name || ''} ${c.last_name || ''}`.trim(), c => `/contacts/${c.id}`) },
    { field: 'ticket_id', label: 'Billet', span: 2, input: linked('task_ticket_id', tickets, t => t.title || '(sans titre)', t => `/tickets/${t.id}`) },
    { field: 'assigned_to', label: 'Responsable', span: 2, defaultValue: defaultAssignedTo, input: linked('task_assigned_to', users, u => u.name) },
    {
      field: 'keywords', label: 'Mots-clés', span: 2, defaultValue: [],
      input: ({ value, onChange }) => <KeywordPicker value={value || []} onChange={onChange} hideLabel />,
    },
    { field: 'notes', label: 'Notes', type: 'textarea', rows: 2, span: 2 },
  ]
}

export default function Tasks() {
  const { user } = useAuth()
  const [editing, setEditing] = useState(null)
  const undoableDelete = useUndoableDelete()

  const { rows: tasksRaw, loading, reload } = useListData({ table: 'tasks' })
  const companies = useTable('companies')
  const contacts = useTable('contacts')
  const users = useTable('users')
  const tickets = useTable('tickets')

  const tasks = useMemo(() => {
    const cById = new Map(companies.map(c => [c.id, c.name]))
    const ctById = new Map(contacts.map(c => [c.id, `${c.first_name || ''} ${c.last_name || ''}`.trim()]))
    const uById = new Map(users.map(u => [u.id, u.name]))
    const uEmpById = new Map(users.map(u => [u.id, u.employee_id]))
    const tkById = new Map(tickets.map(t => [t.id, t.title]))
    const list = tasksRaw.filter(t => !t.deleted_at)
    return list.map(r => ({
      ...r,
      company_name: cById.get(r.company_id) || r.company_name,
      contact_name: ctById.get(r.contact_id) || r.contact_name,
      assigned_name: uById.get(r.assigned_to) || r.assigned_name,
      assigned_employee_id: uEmpById.get(r.assigned_to) || null,
      ticket_title: tkById.get(r.ticket_id) || r.ticket_title,
    }))
  }, [tasksRaw, companies, contacts, users, tickets])

  async function handleCreate(form) {
    await api.tasks.create(form)
    await reload()
  }

  // Autosave (mode édition de TaskForm) : on persiste sans fermer la modale —
  // la fermeture se fait via « Fermer » (onClose).
  async function handleEdit(form) {
    await api.tasks.update(editing.id, form)
    await reload()
  }

  async function handleDelete(row) {
    setEditing(null)
    await undoableDelete({
      table: 'tasks',
      id: row.id,
      deleteFn: () => api.tasks.delete(row.id),
      label: 'Tâche supprimée',
      onChange: reload,
    })
  }

  return (
    <ListPage
      title="Tâches"
      subtitle={<p className="text-sm text-slate-500 mt-0.5">{tasks.length} tâche{tasks.length !== 1 ? 's' : ''}</p>}
      create={{
        label: 'Nouvelle tâche', table: 'tasks', columns: 2,
        fields: taskFormFields({ companies, contacts, users, tickets, defaultAssignedTo: user?.id || '' }),
        onSubmit: handleCreate,
      }}
    >
      <DataTable
        table="tasks"
        manageViews
        columns={COLUMNS}
        data={tasks}
        loading={loading}
        onRowClick={(row) => setEditing(row)}
        searchFields={['title', 'company_name', 'contact_name', 'assigned_name', 'ticket_title']}
        onBulkDelete={async (ids) => {
          await undoableDelete({
            table: 'tasks',
            ids,
            deleteFn: () => Promise.all(ids.map(id => api.tasks.delete(id))),
            label: `${ids.length} tâche${ids.length > 1 ? 's' : ''} supprimée${ids.length > 1 ? 's' : ''}`,
            onChange: reload,
          })
        }}
      />

      {editing && (
        <RecordPeekDrawer open onClose={() => setEditing(null)} title={editing.title || 'Tâche'} subtitle={editing.company_name || undefined} width={640} peekKey="tasks">
          <div className="px-5 py-4">
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
          </div>
        </RecordPeekDrawer>
      )}
    </ListPage>
  )
}
