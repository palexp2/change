import { useState, useEffect, useMemo } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, Plus, Save, X } from 'lucide-react'
import InteractionTimeline from '../components/InteractionTimeline.jsx'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { Badge } from '../components/Badge.jsx'
import { Modal } from '../components/Modal.jsx'
import LinkedRecordField from '../components/LinkedRecordField.jsx'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { useUndoableDelete } from '../lib/undoableDelete.js'
import { useAuth } from '../lib/auth.jsx'
import { fmtDateTime } from '../lib/formatDate.js'


function _fmtDuration(s) {
  if (!s) return null
  const m = Math.floor(s / 60), sec = s % 60
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`
}


function fieldTypeInput(type) {
  if (type === 'number') return 'number'
  if (type === 'date') return 'date'
  if (type === 'url') return 'url'
  if (type === 'email') return 'email'
  return 'text'
}

function fmtPhone(val) {
  if (!val) return ''
  const digits = String(val).replace(/\D/g, '')
  const d = digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
  return val
}

const CONTACT_FIELDS = [
  { key: 'first_name', label: 'Prénom',      type: 'text', required: true },
  { key: 'last_name',  label: 'Nom',         type: 'text', required: true },
  { key: 'email',      label: 'Courriel',    type: 'email' },
  { key: 'phone',      label: 'Téléphone',   type: 'phone' },
  { key: 'mobile',     label: 'Mobile',      type: 'phone' },
  { key: 'language',   label: 'Langue',      type: 'select', options: ['French', 'English'] },
  { key: 'company_id', label: 'Entreprise',  type: 'company', span2: true },
  { key: 'notes',      label: 'Notes',       type: 'textarea', span2: true, defaultVisible: false },
]

function InlineField({ field, value, saving, onSave, companies = [] }) {
  const [local, setLocal] = useState(String(value ?? ''))
  useEffect(() => { setLocal(String(value ?? '')) }, [value])
  function commit(val) { if (val === String(value ?? '')) return; onSave(val) }

  if (field.type === 'select') {
    return (
      <select value={local} onChange={e => { setLocal(e.target.value); commit(e.target.value) }} className="input text-sm" disabled={saving}>
        <option value="">—</option>
        {(field.options || []).map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    )
  }
  if (field.type === 'company') {
    return (
      <LinkedRecordField
        name="company_id"
        value={value}
        options={companies}
        labelFn={c => c.name}
        getHref={c => `/companies/${c.id}`}
        placeholder="Entreprise"
        saving={saving}
        onChange={onSave}
      />
    )
  }
  if (field.type === 'textarea') {
    return (
      <textarea value={local} onChange={e => setLocal(e.target.value)} onBlur={e => commit(e.target.value)} className="input text-sm" rows={3} disabled={saving} />
    )
  }
  if (field.type === 'phone') {
    return (
      <input type="tel" value={local} onChange={e => setLocal(e.target.value)}
        onBlur={e => { const f = fmtPhone(e.target.value); setLocal(f); commit(f) }}
        className="input text-sm" disabled={saving} />
    )
  }
  return (
    <input type={fieldTypeInput(field.type)} value={local} onChange={e => setLocal(e.target.value)} onBlur={e => commit(e.target.value)} className="input text-sm" disabled={saving} />
  )
}

function TaskModalContent({ contactId, editingTask, users, taskForm, setTaskForm, savingTask, setSavingTask, onClose, onRefresh }) {
  const isEdit = !!editingTask
  const [fieldSaving, setFieldSaving] = useState({})
  const confirm = useConfirm()
  const { addToast } = useToast()
  const undoableDelete = useUndoableDelete()

  const saveField = async (key, value) => {
    setTaskForm(f => ({ ...f, [key]: value }))
    if (!isEdit) return
    setFieldSaving(s => ({ ...s, [key]: true }))
    try {
      await api.tasks.update(editingTask.id, { [key]: value })
      onRefresh()
    } catch (err) {
      addToast({ message: err.message, type: 'error' })
    } finally {
      setFieldSaving(s => ({ ...s, [key]: false }))
    }
  }

  async function handleSubmitCreate(e) {
    e.preventDefault()
    setSavingTask(true)
    try {
      await api.tasks.create({ ...taskForm, contact_id: contactId })
      await onRefresh()
      onClose()
    } catch (err) {
      addToast({ message: err.message, type: 'error' })
    } finally {
      setSavingTask(false)
    }
  }

  async function handleDelete() {
    if (!(await confirm('Supprimer cette tâche ?'))) return
    onClose()
    await undoableDelete({
      table: 'tasks',
      id: editingTask.id,
      deleteFn: () => api.tasks.delete(editingTask.id),
      label: 'Tâche supprimée',
      onChange: onRefresh,
    })
  }

  const anySaving = Object.values(fieldSaving).some(Boolean)

  const fields = (
    <>
      <div>
        <label className="label">Titre *</label>
        <input
          value={taskForm.title}
          onChange={e => setTaskForm(f => ({ ...f, title: e.target.value }))}
          onBlur={isEdit ? e => saveField('title', e.target.value) : undefined}
          className="input"
          required
          autoFocus
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Statut</label>
          <select
            value={taskForm.status}
            onChange={e => isEdit ? saveField('status', e.target.value) : setTaskForm(f => ({ ...f, status: e.target.value }))}
            className="select"
          >
            {['À faire','En cours','Terminé','Annulé'].map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Priorité</label>
          <select
            value={taskForm.priority}
            onChange={e => isEdit ? saveField('priority', e.target.value) : setTaskForm(f => ({ ...f, priority: e.target.value }))}
            className="select"
          >
            {['Basse','Normal','Haute','Urgente'].map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
      </div>
      <div>
        <label className="label">Échéance</label>
        <input
          type="date"
          value={taskForm.due_date || ''}
          onChange={e => isEdit ? saveField('due_date', e.target.value) : setTaskForm(f => ({ ...f, due_date: e.target.value }))}
          className="input"
        />
      </div>
      <div>
        <label className="label">Responsable</label>
        <LinkedRecordField
          name="task_assigned_to"
          value={taskForm.assigned_to || ''}
          options={users}
          labelFn={u => u.name}
          placeholder="Responsable"
          saving={!!fieldSaving.assigned_to}
          onChange={v => isEdit ? saveField('assigned_to', v) : setTaskForm(f => ({ ...f, assigned_to: v }))}
        />
      </div>
      <div>
        <label className="label">Notes</label>
        <textarea
          value={taskForm.notes || ''}
          onChange={e => setTaskForm(f => ({ ...f, notes: e.target.value }))}
          onBlur={isEdit ? e => saveField('notes', e.target.value) : undefined}
          className="input"
          rows={2}
        />
      </div>
    </>
  )

  return (
    <Modal title={isEdit ? 'Modifier la tâche' : 'Nouvelle tâche'} onClose={onClose}>
      {isEdit ? (
        <div className="space-y-4">
          {fields}
          <div className="flex items-center justify-between pt-2">
            <button type="button" onClick={handleDelete} className="text-sm text-red-500 hover:text-red-700 hover:underline">Supprimer</button>
            <div className="flex items-center gap-3 ml-auto">
              {anySaving && <span className="text-xs text-slate-400">Sauvegarde…</span>}
              <button type="button" onClick={onClose} className="btn-secondary"><X size={14} /> Fermer</button>
            </div>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmitCreate} className="space-y-4">
          {fields}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="btn-secondary"><X size={14} /> Annuler</button>
            <button type="submit" disabled={savingTask} className="btn-primary"><Save size={14} /> {savingTask ? 'Enregistrement...' : 'Enregistrer'}</button>
          </div>
        </form>
      )}
    </Modal>
  )
}

export default function ContactDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user: _user } = useAuth()
  const { addToast } = useToast()
  const [contact, setContact] = useState(null)
  const [interactions, setInteractions] = useState([])
  const [companies, setCompanies] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [fieldSaving, setFieldSaving] = useState({})
  const [tasks, setTasks] = useState([])
  const [users, setUsers] = useState([])
  const [showTaskModal, setShowTaskModal] = useState(false)
  const [editingTask, setEditingTask] = useState(null)
  const [taskForm, setTaskForm] = useState({ title: '', status: 'À faire', priority: 'Normal', due_date: '', assigned_to: '', notes: '' })
  const [savingTask, setSavingTask] = useState(false)
  const LIMIT = 30

  async function load() {
    setLoading(true)
    try {
      const [c, inter, comps] = await Promise.all([
        api.contacts.get(id),
        api.interactions.list({ contact_id: id, limit: LIMIT, offset: 0, include: 'heavy' }),
        api.companies.lookup(),
      ])
      setContact(c)
      setInteractions(inter.interactions || [])
      setTotal(inter.total || 0)
      setOffset(LIMIT)
      setCompanies(comps)
    } finally {
      setLoading(false)
    }
  }

  const visibleFields = useMemo(() => CONTACT_FIELDS.filter(f => f.defaultVisible !== false), [])

  async function loadMore() {
    setLoadingMore(true)
    try {
      const res = await api.interactions.list({ contact_id: id, limit: LIMIT, offset, include: 'heavy' })
      setInteractions(prev => [...prev, ...(res.interactions || [])])
      setOffset(o => o + LIMIT)
    } finally {
      setLoadingMore(false)
    }
  }

  useEffect(() => {
    load()
    api.tasks.list({ contact_id: id, limit: 'all' }).then(r => setTasks(r.data || [])).catch(() => {})
    api.auth.users().then(setUsers).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  async function saveField(key, value) {
    setFieldSaving(s => ({ ...s, [key]: true }))
    try {
      await api.contacts.update(id, { [key]: value || null })
      setContact(c => ({ ...c, [key]: value || null }))
      if (key === 'company_id') load()
    } catch (err) {
      addToast({ message: err.message, type: 'error' })
    } finally {
      setFieldSaving(s => ({ ...s, [key]: false }))
    }
  }

  if (loading) {
    return <Layout><div className="flex items-center justify-center h-64"><div className="animate-spin rounded-full h-10 w-10 border-b-2 border-brand-600" /></div></Layout>
  }
  if (!contact) {
    return <Layout><div className="p-6 text-slate-500">Contact introuvable.</div></Layout>
  }

  return (
    <Layout>
      <div className="p-6 max-w-3xl mx-auto">
        {/* Header */}
        <div className="flex items-start gap-4 mb-6">
          <button onClick={() => navigate('/contacts')} className="mt-1 p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg">
            <ArrowLeft size={18} />
          </button>
          <div className="flex-1">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-2xl font-bold text-slate-900">{contact.first_name} {contact.last_name}</h1>
              {contact.language && (
                <Badge color={contact.language === 'French' ? 'blue' : 'green'}>
                  {contact.language === 'French' ? 'FR' : 'EN'}
                </Badge>
              )}
            </div>
            {contact.company_id && (
              <Link to={`/companies/${contact.company_id}`} className="text-sm text-brand-600 hover:underline mt-0.5 block">
                {contact.company_name}
              </Link>
            )}
          </div>
          <div className="flex items-center gap-2">
          </div>
        </div>

        {/* Info card */}
        <div className="card p-5 mb-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4 text-sm">
            {visibleFields.map(field => {
              const value = contact[field.key] ?? ''
              const span2 = field.span2 || field.type === 'textarea' || field.type === 'company'
              return (
                <div key={field.key} className={span2 ? 'sm:col-span-2' : ''}>
                  <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-1 flex items-center gap-1">
                    {field.label}
                    {fieldSaving[field.key] && <span className="inline-block w-3 h-3 border border-brand-400 border-t-transparent rounded-full animate-spin" />}
                  </div>
                  <InlineField
                    field={field}
                    value={value}
                    saving={!!fieldSaving[field.key]}
                    companies={companies}
                    onSave={val => saveField(field.key, val)}
                  />
                </div>
              )
            })}
          </div>
        </div>

        {/* Tasks section */}
        <div className="mb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold text-slate-900">Tâches ({tasks.length})</h2>
            <button onClick={() => { setEditingTask(null); setTaskForm({ title: '', status: 'À faire', priority: 'Normal', due_date: '', assigned_to: '', notes: '' }); setShowTaskModal(true) }} className="btn-secondary btn-sm">
              <Plus size={14} /> Ajouter
            </button>
          </div>
          {tasks.length === 0 ? (
            <div className="card p-6 text-center text-slate-400 text-sm">Aucune tâche</div>
          ) : (
            <div className="card overflow-hidden">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-slate-200 bg-slate-50">
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-slate-500">Tâche</th>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-slate-500">Statut</th>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-slate-500 hidden sm:table-cell">Échéance</th>
                </tr></thead>
                <tbody>
                  {tasks.map(t => {
                    const overdue = t.due_date && t.status !== 'Terminé' && new Date(t.due_date) < new Date()
                    return (
                      <tr key={t.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50 cursor-pointer" onClick={() => { setEditingTask(t); setTaskForm({ title: t.title, status: t.status, priority: t.priority, due_date: t.due_date || '', assigned_to: t.assigned_to || '', notes: t.notes || '' }); setShowTaskModal(true) }}>
                        <td className="px-4 py-2.5 font-medium text-slate-900">{t.title}</td>
                        <td className="px-4 py-2.5">
                          <span className={`inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full ${t.status === 'Terminé' ? 'bg-green-100 text-green-700' : t.status === 'En cours' ? 'bg-blue-100 text-blue-700' : t.status === 'Annulé' ? 'bg-slate-100 text-slate-500' : 'bg-amber-100 text-amber-700'}`}>{t.status}</span>
                        </td>
                        <td className="px-4 py-2.5 hidden sm:table-cell">
                          {t.due_date ? <span className={overdue ? 'text-red-600 font-medium' : 'text-slate-500'}>{fmtDateTime(t.due_date)}</span> : <span className="text-slate-400">—</span>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Conversation history */}
        <div>
          <h2 className="text-base font-semibold text-slate-900 mb-3">
            Historique ({total})
          </h2>
          <InteractionTimeline
            interactions={interactions}
            total={total}
            onLoadMore={loadMore}
            loadingMore={loadingMore}
            showContact={false}
          />
        </div>
      </div>

      {showTaskModal && (
        <TaskModalContent
          contactId={id}
          editingTask={editingTask}
          users={users}
          taskForm={taskForm}
          setTaskForm={setTaskForm}
          savingTask={savingTask}
          setSavingTask={setSavingTask}
          onClose={() => setShowTaskModal(false)}
          onRefresh={async () => {
            const r = await api.tasks.list({ contact_id: id, limit: 'all' })
            setTasks(r.data || [])
          }}
        />
      )}
    </Layout>
  )
}
