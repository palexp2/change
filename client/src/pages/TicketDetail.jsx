import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, Trash2, ChevronDown, ChevronUp, ExternalLink, Plus, CheckCircle2, Circle, Clock, X } from 'lucide-react'
import api from '../lib/api.js'
import { useAuth } from '../lib/auth.jsx'
import { Layout } from '../components/Layout.jsx'
import { Badge, ticketStatusColor } from '../components/Badge.jsx'
import InteractionTimeline from '../components/InteractionTimeline.jsx'
import LinkedRecordField from '../components/LinkedRecordField.jsx'
import { Modal } from '../components/Modal.jsx'
import TaskForm from '../components/TaskForm.jsx'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { fmtDate, fmtDateTime } from '../lib/formatDate.js'


function fmtDuration(mins) {
  if (!mins) return '—'
  const h = Math.floor(mins / 60), m = mins % 60
  return h === 0 ? `${m}m` : `${h}h${m > 0 ? m + 'm' : ''}`
}

export default function TicketDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const [ticket, setTicket] = useState(null)
  const [companies, setCompanies] = useState([])
  const [contacts, setContacts] = useState([])
  const [users, setUsers] = useState([])
  const [meta, setMeta] = useState({ types: [], statuses: [] })
  const [loading, setLoading] = useState(true)
  const [fieldSaving, setFieldSaving] = useState({})
  const [ticketIds, setTicketIds] = useState([])
  const [linkedInteractions, setLinkedInteractions] = useState([])
  const [loadingInteractions, setLoadingInteractions] = useState(false)
  const [linkedTasks, setLinkedTasks] = useState([])
  const [loadingTasks, setLoadingTasks] = useState(false)
  const [showTaskModal, setShowTaskModal] = useState(false)
  const [editingTask, setEditingTask] = useState(null)
  const confirm = useConfirm()
  const { addToast } = useToast()

  const loadTasks = useCallback(() => {
    setLoadingTasks(true)
    api.tasks.list({ ticket_id: id, limit: 'all' })
      .then(r => setLinkedTasks(r.data || []))
      .catch(() => setLinkedTasks([]))
      .finally(() => setLoadingTasks(false))
  }, [id])

  useEffect(() => { loadTasks() }, [loadTasks])

  useEffect(() => {
    api.tickets.list({ limit: 'all' })
      .then(res => setTicketIds((res.data || []).map(t => t.id)))
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!ticket?.company_id) {
      setLinkedInteractions([])
      return
    }
    setLoadingInteractions(true)
    api.interactions.list({ company_id: ticket.company_id, limit: 'all', include: 'heavy' })
      .then(d => setLinkedInteractions(d.interactions || []))
      .catch(() => setLinkedInteractions([]))
      .finally(() => setLoadingInteractions(false))
  }, [ticket?.company_id])

  const currentIdx = ticketIds.indexOf(id)
  const prevId = currentIdx > 0 ? ticketIds[currentIdx - 1] : null
  const nextId = currentIdx >= 0 && currentIdx < ticketIds.length - 1 ? ticketIds[currentIdx + 1] : null

  useEffect(() => {
    async function load() {
      setLoading(true)
      try {
        const [t, comps, conts, m] = await Promise.all([
          api.tickets.get(id),
          api.companies.lookup(),
          api.contacts.lookup(),
          api.tickets.meta(),
        ])
        setTicket(t)
        setCompanies(comps)
        setContacts(conts)
        setMeta(m)
        api.admin.listUsers().then(setUsers).catch(() => {})
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [id])

  async function saveField(key, value) {
    setFieldSaving(s => ({ ...s, [key]: true }))
    try {
      const updated = await api.tickets.update(id, { ...ticket, [key]: value || null })
      setTicket(updated)
    } catch (err) {
      addToast({ message: err.message, type: 'error' })
    } finally {
      setFieldSaving(s => ({ ...s, [key]: false }))
    }
  }

  async function handleDelete() {
    if (!(await confirm('Supprimer ce billet ?'))) return
    await api.tickets.delete(id)
    navigate('/tickets')
  }

  async function handleCreateTask(form) {
    await api.tasks.create({ ...form, ticket_id: id })
    loadTasks()
  }

  async function handleEditTask(form) {
    await api.tasks.update(editingTask.id, form)
    setEditingTask(null)
    loadTasks()
  }

  async function handleDeleteTask(taskId) {
    if (!(await confirm('Supprimer cette tâche ?'))) return
    await api.tasks.delete(taskId)
    setEditingTask(null)
    loadTasks()
  }

  const filteredContacts = ticket?.company_id
    ? contacts.filter(c => c.company_id === ticket.company_id)
    : contacts

  if (loading) {
    return <Layout><div className="flex items-center justify-center h-64"><div className="animate-spin rounded-full h-10 w-10 border-b-2 border-brand-600" /></div></Layout>
  }
  if (!ticket) {
    return <Layout><div className="p-6 text-slate-500">Billet introuvable.</div></Layout>
  }

  return (
    <Layout>
      <div className="p-6 max-w-3xl mx-auto">
        {/* Header */}
        <div className="flex items-start gap-4 mb-6">
          <button onClick={() => navigate('/tickets')} className="mt-1 p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg">
            <ArrowLeft size={18} />
          </button>
          <div className="flex-1">
            <h1 className="text-2xl font-bold text-slate-900">{ticket.title}</h1>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <Badge color={ticketStatusColor(ticket.status)}>{ticket.status}</Badge>
              {ticket.type && <Badge color="gray">{ticket.type}</Badge>}
              <OrishaLinks controllers={ticket.central_controllers} />
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => prevId && navigate(`/tickets/${prevId}`)}
              disabled={!prevId}
              className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed"
              title="Billet précédent"
            >
              <ChevronUp size={16} />
            </button>
            <button
              onClick={() => nextId && navigate(`/tickets/${nextId}`)}
              disabled={!nextId}
              className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed"
              title="Billet suivant"
            >
              <ChevronDown size={16} />
            </button>
          </div>
          <button onClick={handleDelete} className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg" title="Supprimer">
            <Trash2 size={16} />
          </button>
        </div>

        {/* Info card */}
        <div className="card p-5 mb-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4 text-sm">
            <div className="sm:col-span-2">
              <FieldLabel label="Titre" saving={fieldSaving.title} />
              <InlineText value={ticket.title} saving={!!fieldSaving.title} onSave={v => saveField('title', v)} />
            </div>
            <div>
              <FieldLabel label="Statut" saving={fieldSaving.status} />
              <select value={ticket.status || ''} onChange={e => saveField('status', e.target.value)} className="select text-sm w-full" disabled={!!fieldSaving.status}>
                <option value="">—</option>
                {meta.statuses.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <FieldLabel label="Type" saving={fieldSaving.type} />
              <select value={ticket.type || ''} onChange={e => saveField('type', e.target.value)} className="select text-sm w-full" disabled={!!fieldSaving.type}>
                <option value="">—</option>
                {meta.types.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <FieldLabel label="Entreprise" saving={fieldSaving.company_id} />
              <LinkedRecordField
                name="company_id"
                value={ticket.company_id}
                options={companies}
                labelFn={c => c.name}
                getHref={c => `/companies/${c.id}`}
                placeholder="Entreprise"
                saving={!!fieldSaving.company_id}
                onChange={v => saveField('company_id', v)}
              />
            </div>
            <div>
              <FieldLabel label="Contact" saving={fieldSaving.contact_id} />
              <LinkedRecordField
                name="contact_id"
                value={ticket.contact_id}
                options={filteredContacts}
                labelFn={c => `${c.first_name} ${c.last_name}`}
                getHref={c => `/contacts/${c.id}`}
                placeholder="Contact"
                saving={!!fieldSaving.contact_id}
                onChange={v => saveField('contact_id', v)}
              />
            </div>
            <div>
              <FieldLabel label="Assigne a" saving={fieldSaving.assigned_to} />
              <LinkedRecordField
                name="assigned_to"
                value={ticket.assigned_to}
                options={users}
                labelFn={u => u.name}
                placeholder="Assigner"
                saving={!!fieldSaving.assigned_to}
                onChange={v => saveField('assigned_to', v)}
              />
            </div>
            <div>
              <FieldLabel label="Duree" saving={fieldSaving.duration_minutes} />
              <div className="flex items-center gap-2">
                <input type="number" min="0" value={ticket.duration_minutes || 0}
                  onChange={e => saveField('duration_minutes', parseInt(e.target.value) || 0)}
                  className="input text-sm w-24" disabled={!!fieldSaving.duration_minutes} />
                <span className="text-xs text-slate-400">{fmtDuration(ticket.duration_minutes)}</span>
              </div>
            </div>
            <div className="sm:col-span-2">
              <FieldLabel label="Question" saving={fieldSaving.description} />
              <InlineTextarea value={ticket.description} saving={!!fieldSaving.description} onSave={v => saveField('description', v)} />
            </div>
            <div className="sm:col-span-2">
              <FieldLabel label="Réponse" saving={fieldSaving.response} />
              <InlineTextarea value={ticket.response} saving={!!fieldSaving.response} onSave={v => saveField('response', v)} />
            </div>
            <div className="sm:col-span-2">
              <FieldLabel label="Lien GitHub" saving={fieldSaving.lien_issue_github} />
              <InlineUrl value={ticket.lien_issue_github} saving={!!fieldSaving.lien_issue_github} onSave={v => saveField('lien_issue_github', v)} placeholder="https://github.com/…/issues/123" />
            </div>
            <div>
              <FieldLabel label="Escalade" saving={fieldSaving.escalade} />
              <InlineText value={ticket.escalade} saving={!!fieldSaving.escalade} onSave={v => saveField('escalade', v)} />
            </div>
            <div>
              <FieldLabel label="Arbre de troubleshoot utilisé" saving={fieldSaving.arbre_de_troubleshoot_utilise} />
              <InlineText value={ticket.arbre_de_troubleshoot_utilise} saving={!!fieldSaving.arbre_de_troubleshoot_utilise} onSave={v => saveField('arbre_de_troubleshoot_utilise', v)} />
            </div>
            <div className="sm:col-span-2">
              <FieldLabel label="Mots-clés" saving={fieldSaving.mots_cles} />
              <InlineText value={ticket.mots_cles} saving={!!fieldSaving.mots_cles} onSave={v => saveField('mots_cles', v)} placeholder="mot1, mot2, mot3" />
            </div>
            <div className="sm:col-span-2">
              <FieldLabel label="Documents" saving={fieldSaving.documents} />
              <InlineTextarea value={ticket.documents} saving={!!fieldSaving.documents} onSave={v => saveField('documents', v)} />
            </div>
            <div className="sm:col-span-2">
              <FieldLabel label="Items retour" saving={fieldSaving.items_retours} />
              <InlineTextarea value={ticket.items_retours} saving={!!fieldSaving.items_retours} onSave={v => saveField('items_retours', v)} />
            </div>
          </div>
        </div>

        {/* Meta */}
        <div className="text-xs text-slate-400 flex gap-4">
          <span>Cree: {fmtDateTime(ticket.created_at)}</span>
          {ticket.updated_at && <span>Modifie: {fmtDateTime(ticket.updated_at)}</span>}
        </div>

        {/* Tâches liées */}
        <div className="mt-8">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wide">
              Tâches liées
            </h2>
            <button
              onClick={() => setShowTaskModal(true)}
              className="inline-flex items-center gap-1 text-xs text-brand-600 hover:text-brand-700"
              data-testid="ticket-new-task"
            >
              <Plus size={12} /> Nouvelle tâche
            </button>
          </div>
          {loadingTasks ? (
            <div className="text-xs text-slate-400">Chargement…</div>
          ) : linkedTasks.length === 0 ? (
            <div className="text-xs text-slate-400">Aucune tâche liée.</div>
          ) : (
            <div className="card divide-y divide-slate-100">
              {linkedTasks.map(t => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setEditingTask(t)}
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-slate-50"
                  data-testid="ticket-task-row"
                >
                  <TaskStatusIcon status={t.status} />
                  <div className="flex-1 min-w-0">
                    <div className={`text-sm font-medium truncate ${t.status === 'Terminé' ? 'line-through text-slate-400' : 'text-slate-900'}`}>
                      {t.title}
                    </div>
                    <div className="text-xs text-slate-400 flex gap-3 mt-0.5">
                      {t.assigned_name && <span>{t.assigned_name}</span>}
                      {t.due_date && <span>Échéance {fmtDate(t.due_date)}</span>}
                    </div>
                  </div>
                  <Badge color={taskStatusColor(t.status)} size="sm">{t.status}</Badge>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Interactions liées (toutes, même entreprise) */}
        {ticket.company_id && (
          <div className="mt-8">
            <div className="flex items-baseline justify-between mb-3">
              <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wide">
                Interactions liées
              </h2>
              <span className="text-xs text-slate-400">
                Même entreprise
              </span>
            </div>
            <InteractionTimeline
              interactions={linkedInteractions}
              loading={loadingInteractions}
              total={linkedInteractions.length}
            />
          </div>
        )}
      </div>

      <Modal isOpen={showTaskModal} title="Nouvelle tâche" onClose={() => setShowTaskModal(false)}>
        <TaskForm
          companies={companies}
          contacts={ticket?.company_id ? contacts.filter(c => c.company_id === ticket.company_id) : contacts}
          users={users}
          tickets={[{ id: ticket?.id, title: ticket?.title }]}
          initial={{
            company_id: ticket?.company_id || '',
            contact_id: ticket?.contact_id || '',
            ticket_id: ticket?.id || '',
          }}
          defaultAssignedTo={user?.id || ''}
          onSave={handleCreateTask}
          onClose={() => setShowTaskModal(false)}
        />
      </Modal>

      {editingTask && (
        <Modal isOpen={!!editingTask} title="Modifier la tâche" onClose={() => setEditingTask(null)}>
          <TaskForm
            initial={editingTask}
            companies={companies}
            contacts={contacts}
            users={users}
            tickets={[{ id: ticket?.id, title: ticket?.title }]}
            onSave={handleEditTask}
            onClose={() => setEditingTask(null)}
          />
          <div className="flex justify-start pt-2 border-t border-slate-200 mt-2">
            <button
              onClick={() => handleDeleteTask(editingTask.id)}
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

function taskStatusColor(s) {
  if (s === 'Terminé') return 'green'
  if (s === 'En cours') return 'blue'
  if (s === 'Annulé') return 'gray'
  return 'slate'
}

function TaskStatusIcon({ status }) {
  if (status === 'Terminé') return <CheckCircle2 size={16} className="text-green-500 flex-shrink-0" />
  if (status === 'En cours') return <Clock size={16} className="text-blue-500 flex-shrink-0" />
  if (status === 'Annulé') return <X size={16} className="text-slate-400 flex-shrink-0" />
  return <Circle size={16} className="text-slate-400 flex-shrink-0" />
}

function OrishaLinks({ controllers }) {
  if (!controllers?.length) return null
  const single = controllers.length === 1
  return (
    <>
      {controllers.map(cc => (
        <a
          key={cc.address}
          href={`https://app.orisha.io/#admin/${encodeURIComponent(cc.address)}`}
          target="_blank"
          rel="noopener noreferrer"
          title={cc.serial ? `Contrôleur ${cc.serial} · adresse ${cc.address}` : `Adresse ${cc.address}`}
          className="inline-flex items-center gap-1 text-sm text-brand-600 hover:underline"
        >
          <ExternalLink size={12} />
          {single ? 'Ouvrir dans Orisha' : `Orisha ${cc.address}`}
        </a>
      ))}
    </>
  )
}

function FieldLabel({ label, saving }) {
  return (
    <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-1 flex items-center gap-1">
      {label}
      {saving && <span className="inline-block w-3 h-3 border border-brand-400 border-t-transparent rounded-full animate-spin" />}
    </div>
  )
}

function InlineText({ value, saving, onSave, placeholder }) {
  const [local, setLocal] = useState(value || '')
  useEffect(() => { setLocal(value || '') }, [value])
  return (
    <input type="text" value={local} onChange={e => setLocal(e.target.value)}
      onBlur={e => { if (e.target.value !== (value || '')) onSave(e.target.value) }}
      placeholder={placeholder}
      className="input text-sm w-full" disabled={saving} />
  )
}

function InlineUrl({ value, saving, onSave, placeholder }) {
  const [local, setLocal] = useState(value || '')
  useEffect(() => { setLocal(value || '') }, [value])
  const isValidLink = value && /^https?:\/\//i.test(value)
  return (
    <div className="flex items-center gap-2">
      <input
        type="url"
        value={local}
        onChange={e => setLocal(e.target.value)}
        onBlur={e => { if (e.target.value !== (value || '')) onSave(e.target.value) }}
        placeholder={placeholder}
        className="input text-sm flex-1"
        disabled={saving}
      />
      {isValidLink && (
        <a href={value} target="_blank" rel="noopener noreferrer" title="Ouvrir le lien" className="p-1.5 text-slate-400 hover:text-brand-600">
          <ExternalLink size={14} />
        </a>
      )}
    </div>
  )
}

function InlineTextarea({ value, saving, onSave }) {
  const [local, setLocal] = useState(value || '')
  const ref = useRef(null)
  useEffect(() => { setLocal(value || '') }, [value])
  useEffect(() => { autoResize() }, [local])

  function autoResize() {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = el.scrollHeight + 'px'
  }

  return (
    <textarea ref={ref} value={local} onChange={e => setLocal(e.target.value)}
      onBlur={e => { if (e.target.value !== (value || '')) onSave(e.target.value) }}
      className="input text-sm w-full resize-none overflow-hidden" rows={1} disabled={saving} />
  )
}
