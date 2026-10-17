import { useState, useMemo, useRef, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Check, AlertCircle, Mail, Phone, Users, ArrowDownLeft, ArrowUpRight } from 'lucide-react'
import { api } from '../lib/api.js'
import { useAuth } from '../lib/auth.jsx'
import { useTable } from '../lib/dataStore.js'
import { useListData } from '../lib/useListData.js'
import { ListPage } from '../components/ListPage.jsx'
import { Badge } from '../components/Badge.jsx'
import RecordPeekDrawer from '../components/RecordPeekDrawer.jsx'
import { DataTable } from '../components/DataTable.jsx'
import TaskForm, { KeywordPicker, parseKeywords } from '../components/TaskForm.jsx'
import LinkedRecordField from '../components/LinkedRecordField.jsx'
import InteractionTimeline from '../components/InteractionTimeline.jsx'
import { useUndoableDelete } from '../lib/undoableDelete.js'
import { TABLE_COLUMN_META, TASK_STATUS_CHOICES, TASK_PRIORITY_CHOICES } from '../lib/tableDefs.js'
import { fmtDate, localISODate } from '../lib/formatDate.js'
import { useToast } from '../contexts/ToastContext.jsx'


const statusColor = s => TASK_STATUS_CHOICES.find(c => c.value === s)?.color || 'slate'
const priorityColor = p => TASK_PRIORITY_CHOICES.find(c => c.value === p)?.color || 'gray'

// Rond vide → rond vert coché : marque la tâche terminée en un clic.
function DoneToggle({ row, onToggle }) {
  const done = row.status === 'Terminé'
  return (
    <button
      type="button"
      title={done ? 'Rouvrir' : 'Terminer'}
      onMouseDown={e => e.stopPropagation()}
      onClick={e => { e.stopPropagation(); onToggle(row) }}
      className={`flex items-center justify-center w-5 h-5 rounded-full border transition-colors ${done ? 'bg-green-500 border-green-500 text-white' : 'border-slate-300 hover:border-green-500 text-transparent hover:text-green-500'}`}
    >
      <Check size={12} strokeWidth={3} />
    </button>
  )
}

const RENDERS = {
  title: (row) => (
    <span className={`text-sm font-medium ${row.status === 'Terminé' ? 'line-through text-slate-400' : 'text-slate-900'}`}>{row.title}</span>
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
    ? <Link to={`/companies/${row.company_id}`} onClick={e => e.stopPropagation()} className="link-record text-sm">{row.company_name}</Link>
    : <span className="text-slate-400">—</span>,
  contact_name: (row) => row.contact_id
    ? <Link to={`/contacts/${row.contact_id}`} onClick={e => e.stopPropagation()} className="link-record text-sm">{row.contact_name}</Link>
    : <span className="text-slate-400">—</span>,
  assigned_name: (row) => row.assigned_employee_id
    ? <Link to={`/employees/${row.assigned_employee_id}`} onClick={e => e.stopPropagation()} className="link-record text-sm">{row.assigned_name}</Link>
    : (row.assigned_name || <span className="text-slate-400">—</span>),
  created_at: (row) => fmtDate(row.created_at),
  last_exchange: (row) => {
    const x = row.last_exchange
    if (!x) return <span className="text-slate-400">—</span>
    const Icon = EXCHANGE_ICONS[x.type] || Mail
    const client = x.direction === 'in'
    const Arrow = client ? ArrowDownLeft : ArrowUpRight
    return (
      <span title={client ? 'Le client' : 'Orisha'} className={`inline-flex items-center gap-1 text-sm ${client ? 'text-green-700 font-medium' : 'text-slate-500'}`}>
        <Icon size={13} />{x.direction && <Arrow size={13} />}{fmtDate(x.at)}
      </span>
    )
  },
}

const EXCHANGE_ICONS = { email: Mail, call: Phone, meeting: Users }

// Relance proposée quand une tâche passe à « Terminé » : échéance dans N jours,
// repoussée au lundi si elle tombe la fin de semaine.
const FOLLOW_UPS = [[2, '+2 j'], [7, '+1 sem'], [14, '+2 sem']]
function followUpDate(days) {
  const d = new Date()
  d.setDate(d.getDate() + days)
  const wd = d.getDay()
  if (wd === 6) d.setDate(d.getDate() + 2)
  if (wd === 0) d.setDate(d.getDate() + 1)
  return localISODate(d)
}

// Fil des derniers échanges avec le client de la tâche : avant de relancer, le
// vendeur voit où il en est sans ouvrir la fiche entreprise.
const EXCHANGES_LIMIT = 5
function TaskExchanges({ companyId, contactId }) {
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const scope = companyId ? { company_id: companyId } : contactId ? { contact_id: contactId } : null
  const key = companyId || contactId || ''
  useEffect(() => {
    if (!key) return
    const ctrl = new AbortController()
    setLoading(true)
    setItems([])
    api.interactions.list({ ...scope, limit: EXCHANGES_LIMIT, offset: 0, include: 'heavy' }, ctrl.signal)
      .then(d => { setItems(d.interactions || []); setTotal(d.total || 0) })
      .catch(() => {})
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false) })
    return () => ctrl.abort()
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `scope` dérive de `key`
  }, [key])
  if (!scope) return null
  async function loadMore() {
    setLoadingMore(true)
    try {
      const d = await api.interactions.list({ ...scope, limit: EXCHANGES_LIMIT * 2, offset: items.length, include: 'heavy' })
      setItems(prev => [...prev, ...(d.interactions || [])])
    } finally { setLoadingMore(false) }
  }
  return (
    <div className="pt-3 border-t border-slate-200 mt-3">
      <h3 className="text-sm font-semibold text-slate-700 mb-2">Derniers échanges</h3>
      <InteractionTimeline interactions={items} loading={loading} total={total} onLoadMore={loadMore} loadingMore={loadingMore} />
    </div>
  )
}


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
    { field: 'status', label: 'Statut', type: 'select', defaultValue: 'À faire' },
    { field: 'priority', label: 'Priorité', type: 'select', defaultValue: 'Normal' },
    { field: 'type', label: 'Type', type: 'select', options: ['Problème'] },
    { field: 'due_date', label: "Date d'échéance", type: 'date' },
    { field: 'company_id', label: 'Entreprise', input: linked('task_company_id', companies, c => c.name, c => `/companies/${c.id}`) },
    { field: 'contact_id', label: 'Contact', input: linked('task_contact_id', contacts, c => `${c.first_name || ''} ${c.last_name || ''}`.trim(), c => `/contacts/${c.id}`) },
    { field: 'ticket_id', label: 'Billet', span: 2, input: linked('task_ticket_id', tickets, () => 'Billet', t => `/tickets/${t.id}`) },
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
  const { addToast } = useToast()
  const [editing, setEditing] = useState(null)
  const undoableDelete = useUndoableDelete()

  const { rows: tasksRaw, loading, reload } = useListData({ table: 'tasks' })
  const companies = useTable('companies')
  const contacts = useTable('contacts')
  const users = useTable('users')
  const tickets = useTable('tickets')

  // Dernier échange avec le client de chaque tâche ouverte (calculé serveur).
  const [exchanges, setExchanges] = useState({})
  const loadExchanges = () => api.tasks.lastExchanges().then(r => setExchanges(r.data || {})).catch(() => {})
  useEffect(() => { loadExchanges() }, [])

  // Statut posé par la coche, affiché tout de suite sans attendre le rechargement.
  const [statusOverride, setStatusOverride] = useState({})

  async function toggleDone(row) {
    const status = row.status === 'Terminé' ? 'À faire' : 'Terminé'
    setStatusOverride(o => ({ ...o, [row.id]: status }))
    try {
      await api.tasks.updateStatus(row.id, status)
      if (status === 'Terminé') offerFollowUp(row)
      await reload()
    } finally {
      setStatusOverride(o => { const n = { ...o }; delete n[row.id]; return n })
    }
  }

  // Une seule proposition par tâche, même si l'autosave du panneau repasse.
  const offeredRef = useRef(new Set())
  function offerFollowUp(task) {
    if (offeredRef.current.has(task.id)) return
    offeredRef.current.add(task.id)
    addToast({
      message: 'Relancer ?',
      duration: 10000,
      actions: FOLLOW_UPS.map(([days, label]) => ({ label, onClick: () => createFollowUp(task, days) })),
    })
  }

  async function createFollowUp(task, days) {
    const due_date = followUpDate(days)
    try {
      const created = await api.tasks.create({
        title: task.title,
        priority: task.priority || 'Normal',
        due_date,
        company_id: task.company_id || null,
        contact_id: task.contact_id || null,
        assigned_to: task.assigned_to || user?.id || null,
        keywords: parseKeywords(task.keywords),
      })
      await reload()
      loadExchanges()
      addToast({
        type: 'undo',
        message: `Relance le ${fmtDate(due_date)}`,
        duration: 6000,
        action: { label: 'Annuler', onClick: () => api.tasks.delete(created.id).then(reload) },
      })
    } catch (e) {
      addToast({ type: 'error', message: e.message || 'Relance non créée' })
    }
  }

  const toggleRef = useRef(toggleDone)
  toggleRef.current = toggleDone
  const columns = useMemo(() => TABLE_COLUMN_META.tasks.map(meta => ({
    ...meta,
    render: meta.id === 'done' ? (row) => <DoneToggle row={row} onToggle={r => toggleRef.current(r)} /> : RENDERS[meta.id],
  })), [])

  const tasks = useMemo(() => {
    const cById = new Map(companies.map(c => [c.id, c.name]))
    const ctById = new Map(contacts.map(c => [c.id, `${c.first_name || ''} ${c.last_name || ''}`.trim()]))
    const uById = new Map(users.map(u => [u.id, u.name]))
    const uEmpById = new Map(users.map(u => [u.id, u.employee_id]))
    const list = tasksRaw.filter(t => !t.deleted_at)
    return list.map(r => ({
      ...r,
      status: statusOverride[r.id] || r.status,
      company_name: cById.get(r.company_id) || r.company_name,
      contact_name: ctById.get(r.contact_id) || r.contact_name,
      assigned_name: uById.get(r.assigned_to) || r.assigned_name,
      assigned_employee_id: uEmpById.get(r.assigned_to) || null,
      last_exchange: exchanges[r.id] || null,
      last_exchange_at: exchanges[r.id]?.at || null,
    }))
  }, [tasksRaw, companies, contacts, users, statusOverride, exchanges])

  async function handleCreate(form) {
    await api.tasks.create(form)
    await reload()
    loadExchanges()
  }

  // Autosave (mode édition de TaskForm) : on persiste sans fermer la modale —
  // la fermeture se fait via « Fermer » (onClose).
  async function handleEdit(form) {
    await api.tasks.update(editing.id, form)
    if (form.status === 'Terminé' && editing.status !== 'Terminé') offerFollowUp({ ...editing, ...form })
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
        columns={columns}
        data={tasks}
        loading={loading}
        onRowClick={(row) => setEditing(row)}
        searchFields={['title', 'company_name', 'contact_name', 'assigned_name']}
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
            linkifyDescription
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
          <TaskExchanges key={editing.id} companyId={editing.company_id} contactId={editing.contact_id} />
          </div>
        </RecordPeekDrawer>
      )}
    </ListPage>
  )
}
