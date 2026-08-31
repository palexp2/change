import { useState, useEffect, useMemo } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, Plus, Save, Star, X, CheckSquare } from 'lucide-react'
import InteractionTimeline from '../components/InteractionTimeline.jsx'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import Spinner from '../components/Spinner.jsx'
import { Badge } from '../components/Badge.jsx'
import { Modal } from '../components/Modal.jsx'
import LinkedRecordField from '../components/LinkedRecordField.jsx'
import { DataTable } from '../components/DataTable.jsx'
import Attachments from '../components/Attachments.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { useDetailFields } from '../lib/useDetailFields.jsx'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { useUndoableDelete } from '../lib/undoableDelete.js'
import { useAuth } from '../lib/auth.jsx'
import { useRealtimeChannel } from '../lib/useRealtimeChannel.js'
import { fmtDateTime } from '../lib/formatDate.js'
import { SaveStatus, useSaveStatus } from '../components/SaveStatus.jsx'
import { SearchableSelect } from '../components/SearchableSelect.jsx'
import { DetailLoadError } from '../components/DetailLoadError.jsx'
import { fmtPhone } from '../utils/formatters.js'

function fieldTypeInput(type) {
  if (type === 'number') return 'number'
  if (type === 'date') return 'date'
  if (type === 'url') return 'url'
  if (type === 'email') return 'email'
  return 'text'
}

const CONTACT_FIELDS = [
  { key: 'first_name', label: 'Prénom',      type: 'text', required: true },
  { key: 'last_name',  label: 'Nom',         type: 'text', required: true },
  { key: 'email',      label: 'Courriel',    type: 'email' },
  { key: 'phone',      label: 'Téléphone',   type: 'phone' },
  { key: 'mobile',     label: 'Mobile',      type: 'phone' },
  { key: 'language',   label: 'Langue',      type: 'select', options: ['French', 'English'] },
  { key: 'notes',      label: 'Notes',       type: 'textarea', span2: true, defaultVisible: false },
]

function CompanyLinks({ contactId, companies, allCompanies, onChange }) {
  const { addToast } = useToast()
  const confirm = useConfirm()
  const [saving, setSaving] = useState(false)
  const linked = companies || []
  const linkedKey = linked.map(l => l.company_id).join(',')
  const linkedIds = new Set(linked.map(l => l.company_id))
  const available = useMemo(
    () => allCompanies.filter(c => !linkedIds.has(c.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allCompanies, linkedKey]
  )

  async function setPrimary(linkId) {
    setSaving(true)
    try {
      const r = await api.contacts.updateCompany(contactId, linkId, { is_primary: true })
      onChange(r)
    } catch (err) {
      addToast({ message: err.message, type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  async function remove(link) {
    if (!(await confirm(`Retirer ${link.company_name} de ce contact ?`))) return
    setSaving(true)
    try {
      const r = await api.contacts.removeCompany(contactId, link.link_id)
      onChange(r)
    } catch (err) {
      addToast({ message: err.message, type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  async function add(companyId) {
    if (!companyId) return
    setSaving(true)
    try {
      const r = await api.contacts.addCompany(contactId, { company_id: companyId })
      onChange(r)
    } catch (err) {
      addToast({ message: err.message, type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="sm:col-span-2" data-testid="contact-companies">
      <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-1.5 flex items-center gap-1">
        Entreprises
        {saving && <span className="inline-block w-3 h-3 border border-brand-400 border-t-transparent rounded-full animate-spin" />}
      </div>
      <div className="space-y-1.5">
        {linked.length === 0 ? (
          <div className="text-sm text-slate-400 italic">Aucune entreprise liée</div>
        ) : linked.map(link => (
          <div
            key={link.link_id}
            data-testid="contact-company-row"
            data-company-id={link.company_id}
            className="flex items-center gap-2 group"
          >
            <Link
              to={`/companies/${link.company_id}`}
              className="text-sm text-brand-600 hover:underline"
            >
              {link.company_name}
            </Link>
            {link.is_primary ? (
              <Badge color="blue" size="sm">Principale</Badge>
            ) : (
              <button
                type="button"
                onClick={() => setPrimary(link.link_id)}
                disabled={saving}
                className="text-xs text-slate-400 hover:text-brand-600 inline-flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition"
                title="Définir comme principale"
                data-testid="set-primary"
              >
                <Star size={11} /> rendre principale
              </button>
            )}
            <button
              type="button"
              onClick={() => remove(link)}
              disabled={saving}
              className="ml-auto text-slate-300 hover:text-red-500 p-1 opacity-0 group-hover:opacity-100 transition"
              title="Retirer"
              data-testid="remove-company"
            >
              <X size={13} />
            </button>
          </div>
        ))}
        <div className="pt-1">
          <LinkedRecordField
            name="add_company"
            value={null}
            options={available}
            labelFn={c => c.name}
            placeholder="Ajouter une entreprise"
            saving={saving}
            onChange={add}
            allowClear={false}
          />
        </div>
      </div>
    </div>
  )
}

function InlineField({ field, value, saving, onSave }) {
  const [local, setLocal] = useState(String(value ?? ''))
  useEffect(() => { setLocal(String(value ?? '')) }, [value])
  function commit(val) { if (val === String(value ?? '')) return; onSave(val) }

  if (field.type === 'select') {
    // Règle CLAUDE.md : tout dropdown > 10 options doit offrir une recherche.
    if ((field.options || []).length > 10) {
      return (
        <SearchableSelect
          value={local}
          options={(field.options || []).map(o => ({ value: o, label: o }))}
          emptyOption="—"
          placeholder="—"
          onChange={v => { setLocal(v); commit(v) }}
          className="input text-sm"
          size="sm"
          disabled={saving}
          testId={`contact-field-${field.key}`}
        />
      )
    }
    return (
      <select value={local} onChange={e => { setLocal(e.target.value); commit(e.target.value) }} className="input text-sm" disabled={saving}>
        <option value="">—</option>
        {(field.options || []).map(o => <option key={o} value={o}>{o}</option>)}
      </select>
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

function TaskModalContent({ contactId, contactCompanies = [], editingTask, users, taskForm, setTaskForm, savingTask, setSavingTask, onClose, onRefresh }) {
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
    // Trim des champs texte au submit pour éviter des records pollués par des espaces seuls.
    const title = (taskForm.title || '').trim()
    if (!title) {
      addToast({ message: 'Le titre est requis.', type: 'error' })
      return
    }
    setSavingTask(true)
    try {
      const company_id = taskForm.company_id || (contactCompanies.find(c => c.is_primary)?.company_id ?? null)
      await api.tasks.create({ ...taskForm, title, notes: (taskForm.notes || '').trim(), contact_id: contactId, company_id })
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
      {!isEdit && contactCompanies.length > 1 && (
        <div>
          <label className="label">Entreprise</label>
          <SearchableSelect
            value={taskForm.company_id || (contactCompanies.find(c => c.is_primary)?.company_id || '')}
            options={contactCompanies}
            getOptionValue={c => c.company_id}
            getOptionLabel={c => `${c.company_name}${c.is_primary ? ' (principale)' : ''}`}
            getOptionKey={c => c.company_id}
            onChange={v => setTaskForm(f => ({ ...f, company_id: v }))}
            size="sm"
            className="input"
            testId="task-company-picker"
          />
        </div>
      )}
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

// `recordId` + `embedded` permettent de monter cette fiche dans le side-peek
// (RecordPeekDrawer) sans le chrome de page (Layout, bouton retour). En mode
// route normale, l'`id` vient de l'URL.
export default function ContactDetail({ recordId, embedded = false }) {
  const { id: paramId } = useParams()
  const id = recordId ?? paramId
  const navigate = useNavigate()
  const { user: _user } = useAuth()
  const { status: saveState, save } = useSaveStatus()
  const [contact, setContact] = useState(null)
  const [interactions, setInteractions] = useState([])
  const [companies, setCompanies] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
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
    setLoadError(null)
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
    } catch (e) {
      setLoadError(e?.message || 'Erreur de chargement')
    } finally {
      setLoading(false)
    }
  }

  // Les libellés, les masquages et les champs perso viennent du registre commun
  // (custom_fields) : renommer ou supprimer un champ depuis un tableau se voit
  // ici aussi. La mise en page, elle, reste celle de la fiche.
  const baseFields = useMemo(() => CONTACT_FIELDS.filter(f => f.defaultVisible !== false), [])
  const { fields: visibleFields, customFields: extraFields } = useDetailFields('contacts', baseFields)

  // Colonnes DataTable des tâches du contact. Dérivées de la meta contact_tasks,
  // enrichies des render() (setters useState stables → deps vides).
  const taskColumns = useMemo(() => {
    const RENDERS = {
      title: row => <span className="font-medium text-slate-900">{row.title}</span>,
      status: row => (
        <span className={`inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full ${row.status === 'Terminé' ? 'bg-green-100 text-green-700' : row.status === 'En cours' ? 'bg-blue-100 text-blue-700' : row.status === 'Annulé' ? 'bg-slate-100 text-slate-500' : 'bg-amber-100 text-amber-700'}`}>{row.status}</span>
      ),
      due_date: row => {
        if (!row.due_date) return <span className="text-slate-400">—</span>
        const overdue = row.status !== 'Terminé' && new Date(row.due_date) < new Date()
        return <span className={overdue ? 'text-red-600 font-medium' : 'text-slate-500'}>{fmtDateTime(row.due_date)}</span>
      },
    }
    return TABLE_COLUMN_META.contact_tasks.map(m => ({ ...m, render: RENDERS[m.id] }))
  }, [])

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

  useRealtimeChannel(id ? `contact:${id}` : null, (msg) => {
    if (msg.type === 'contact:updated') setContact(c => c ? { ...c, ...msg.payload } : c)
    else if (msg.type === 'contact:deleted') navigate('/contacts')
  })

  async function saveField(key, value) {
    setFieldSaving(s => ({ ...s, [key]: true }))
    try {
      await save(async () => {
        await api.contacts.update(id, { [key]: value || null })
        setContact(c => ({ ...c, [key]: value || null }))
        if (key === 'company_id') load()
      })
    } finally {
      setFieldSaving(s => ({ ...s, [key]: false }))
    }
  }

  // En mode embarqué (side-peek), pas de Layout — le drawer fournit son propre
  // chrome. Sinon, page pleine classique.
  const shell = (content) => (embedded ? content : <Layout>{content}</Layout>)

  if (loading) {
    return shell(<Spinner center />)
  }
  if (loadError && !contact) {
    return shell(<DetailLoadError message={loadError} onRetry={load} />)
  }
  if (!contact) {
    return shell(<div className="p-6 text-slate-500">Contact introuvable.</div>)
  }

  return shell(
    <>
      <div className={embedded ? 'px-5 py-4' : 'p-6 max-w-3xl mx-auto'}>
        {/* Header */}
        {embedded ? (
          <div className="flex items-center gap-3 flex-wrap mb-4">
            {contact.language && (
              <Badge color={contact.language === 'French' ? 'blue' : 'green'}>
                {contact.language === 'French' ? 'FR' : 'EN'}
              </Badge>
            )}
            <SaveStatus status={saveState} />
            {contact.company_id && (
              <Link to={`/companies/${contact.company_id}`} className="text-sm text-brand-600 hover:underline">
                {contact.company_name}
              </Link>
            )}
          </div>
        ) : (
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
                <SaveStatus status={saveState} />
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
        )}

        {/* Info card */}
        <div className="card p-5 mb-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4 text-sm">
            {visibleFields.map(field => {
              const value = contact[field.key] ?? ''
              const span2 = field.span2 || field.type === 'textarea'
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
                    onSave={val => saveField(field.key, val)}
                  />
                </div>
              )
            })}
            <CompanyLinks
              contactId={id}
              companies={contact.companies || []}
              allCompanies={companies}
              onChange={updated => setContact(c => ({ ...c, ...updated }))}
            />
            {/* Champs personnalisés de la table : ils apparaissent ici sans que
                personne n'ait à toucher au code de la fiche. Lecture seule —
                l'édition inline d'une colonne cf_ suppose une route PATCH qui
                la liste explicitement, ce qui n'est pas branché sur contacts. */}
            {extraFields.map(field => (
              <div key={field.key} data-testid={`detail-cf-${field.key}`}>
                <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-1">
                  {field.label}
                </div>
                <div className="text-sm text-slate-700">
                  {field.render(contact[field.key])}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Pièces jointes */}
        <div className="mb-6">
          <Attachments entityType="contacts" entityId={id} />
        </div>

        {/* Tasks section */}
        <div className="mb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold text-slate-900">Tâches ({tasks.length})</h2>
            <button onClick={() => { setEditingTask(null); setTaskForm({ title: '', status: 'À faire', priority: 'Normal', due_date: '', assigned_to: '', notes: '' }); setShowTaskModal(true) }} className="btn-secondary btn-sm">
              <Plus size={14} /> Ajouter
            </button>
          </div>
          <DataTable
            table="contact_tasks"
            columns={taskColumns}
            data={tasks}
            searchFields={['title', 'status']}
            onRowClick={row => { setEditingTask(row); setTaskForm({ title: row.title, status: row.status, priority: row.priority, due_date: row.due_date || '', assigned_to: row.assigned_to || '', notes: row.notes || '' }); setShowTaskModal(true) }}
            height={embedded ? '260px' : 'calc(100vh - 440px)'}
            emptyState={{ icon: CheckSquare, title: 'Aucune tâche', description: "Aucune tâche n'est associée à ce contact pour l'instant.", cta: { label: 'Ajouter', icon: Plus, onClick: () => { setEditingTask(null); setTaskForm({ title: '', status: 'À faire', priority: 'Normal', due_date: '', assigned_to: '', notes: '' }); setShowTaskModal(true) } } }}
          />
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
          contactCompanies={contact.companies || []}
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
    </>
  )
}
