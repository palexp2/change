import { useState, useEffect, useMemo, useRef } from 'react'
import { Plus, Save, Star, X, CheckSquare, Trash2 } from 'lucide-react'
import InteractionTimeline from '../components/InteractionTimeline.jsx'
import EmailAttachments from '../components/EmailAttachments.jsx'
import LogInteractionModal from '../components/LogInteractionModal.jsx'
import { DetailShell, detailPending } from '../components/DetailShell.jsx'
import { CrmDetailLayout, CrmCard, CrmRow, CrmAdd, CrmCenterTabs, scrollCrmToTop } from '../components/CrmDetailLayout.jsx'
import api from '../lib/api.js'
import { Badge } from '../components/Badge.jsx'
import { Modal } from '../components/Modal.jsx'
import LinkedRecordField from '../components/LinkedRecordField.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { useDetailFields } from '../lib/useDetailFields.jsx'
import { DetailFieldGrid, DetailField } from '../components/DetailFieldGrid.jsx'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { useUndoableDelete } from '../lib/undoableDelete.js'
import { sync as syncStore } from '../lib/dataSync.js'
import { useAuth } from '../lib/auth.jsx'
import { useRealtimeChannel } from '../lib/useRealtimeChannel.js'
import { useDetailRecord } from '../lib/useDetailRecord.js'
import { useRecordDeleteAllowed } from '../lib/detailFieldLayout.jsx'
import { fmtDateTime, localISODate } from '../lib/formatDate.js'
import { SaveStatus, useSaveStatus } from '../components/SaveStatus.jsx'
import { SearchableSelect } from '../components/SearchableSelect.jsx'
import { fmtPhone } from '../utils/formatters.js'
import ThinkingOrb from '../components/ThinkingOrb'

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

  // Rendu sans libellé : le composant vit dans une carte « Entreprises » de la
  // colonne des records liés, qui porte déjà le titre.
  return (
    <div data-testid="contact-companies" className="px-1">
      <div className="space-y-1.5">
        {saving && <ThinkingOrb size={12} />}
        {linked.length === 0 ? (
          <div className="text-sm text-slate-400 italic">Aucune entreprise liée</div>
        ) : linked.map(link => (
          <div
            key={link.link_id}
            data-testid="contact-company-row"
            data-company-id={link.company_id}
            className="flex items-center gap-2 group"
          >
            <LinkedRecordField
              name={`company_${link.company_id}`}
              value={link.company_id}
              options={[{ id: link.company_id, name: link.company_name || 'Entreprise' }]}
              getHref={c => `/companies/${c.id}`}
              disabled
              allowClear={false}
            />
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
              className="ml-auto text-slate-300 hover:text-red-500 p-1"
              title="Délier cette entreprise"
              data-testid="remove-company"
            >
              <X size={13} />
            </button>
          </div>
        ))}
        <div className="pt-1 flex items-center gap-1.5">
          <LinkedRecordField
            name="add_company"
            value={null}
            options={available}
            labelFn={c => c.name}
            saving={saving}
            onChange={add}
            allowClear={false}
          />
          <span className="text-xs text-slate-400">Lier une entreprise</span>
        </div>
      </div>
    </div>
  )
}

function InlineField({ field, value, saving, onSave }) {
  // Un téléphone s'affiche « (418) 555-1234 » dès la lecture : la valeur
  // stockée est souvent brute (« +14508883901 »). Le formatage au blur ne
  // suffisait pas — sans édition, le brut restait à l'écran.
  const shown = field.type === 'phone' ? fmtPhone(value) : String(value ?? '')
  const [local, setLocal] = useState(shown)
  useEffect(() => { setLocal(shown) }, [shown])
  // Comparaison sur la valeur AFFICHÉE : un blur sans modification ne doit pas
  // déclencher d'enregistrement juste parce que le numéro est reformaté.
  function commit(val) { if (val === shown) return; onSave(val) }

  if (field.type === 'select') {
    // Règle CLAUDE.md : tout dropdown > 10 options doit offrir une recherche.
    if ((field.options || []).length > 10) {
      return (
        <SearchableSelect
          value={local}
          options={(field.options || []).map(o => ({ value: o, label: o }))}
          emptyOption="—"
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

// Raccourcis d'échéance, comptés depuis aujourd'hui.
const DUE_SHORTCUTS = [
  { label: '1 j', days: 1 },
  { label: '3 j', days: 3 },
  { label: '1 sem', days: 7 },
  { label: '2 sem', days: 14 },
  { label: '1 mois', months: 1 },
]
function dueFromShortcut({ days = 0, months = 0 }) {
  const d = new Date()
  if (months) d.setMonth(d.getMonth() + months)
  d.setDate(d.getDate() + days)
  return localISODate(d)
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
        <div className="flex flex-wrap gap-1 mt-1.5">
          {DUE_SHORTCUTS.map(s => {
            const v = dueFromShortcut(s)
            return (
              <button
                key={s.label}
                type="button"
                onClick={() => isEdit ? saveField('due_date', v) : setTaskForm(f => ({ ...f, due_date: v }))}
                className={`btn-secondary btn-sm${taskForm.due_date === v ? ' ring-1 ring-brand-500' : ''}`}
              >
                {s.label}
              </button>
            )
          })}
        </div>
      </div>
      <div>
        <label className="label">Responsable</label>
        <LinkedRecordField
          name="task_assigned_to"
          value={taskForm.assigned_to || ''}
          options={users}
          labelFn={u => u.name}
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
    <Modal isOpen title={isEdit ? 'Modifier la tâche' : 'Nouvelle tâche'} onClose={onClose}>
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

export default function ContactDetail({ recordId, onClose }) {
  const id = recordId
  // « Suppression permise » : case du mode de personnalisation de la fiche.
  const canDelete = useRecordDeleteAllowed('contacts')
  const { user } = useAuth()
  const confirm = useConfirm()
  const { addToast } = useToast()
  const undoableDelete = useUndoableDelete()
  const { status: saveState, save } = useSaveStatus()
  const [interactions, setInteractions] = useState([])
  const [companies, setCompanies] = useState([])
  const [loadingMore, setLoadingMore] = useState(false)
  const interactionRequest = useRef(false)
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [fieldSaving, setFieldSaving] = useState({})
  const [tasks, setTasks] = useState([])
  const [users, setUsers] = useState([])
  const [showTaskModal, setShowTaskModal] = useState(false)
  const [editingTask, setEditingTask] = useState(null)
  const [taskForm, setTaskForm] = useState({ title: '', status: 'À faire', priority: 'Normal', due_date: '', assigned_to: '', notes: '' })
  const [savingTask, setSavingTask] = useState(false)
  const [showLogModal, setShowLogModal] = useState(false)
  // Colonne du centre : le fil des événements, ou le tableau des tâches ouvert
  // depuis la carte de droite.
  const [centerView, setCenterView] = useState('fil')
  const LIMIT = 30

  // Le record principal (contact) passe par le hook ; interactions et lookup
  // entreprises arrivent du même Promise.all et sont posés au passage.
  const { record: contact, setRecord: setContact, loading, loadError, reload: load } =
    useDetailRecord(async () => {
      const [c, inter, comps] = await Promise.all([
        api.contacts.get(id),
        api.interactions.list({ contact_id: id, limit: LIMIT, offset: 0, include: 'heavy' }),
        api.companies.lookup(),
      ])
      setInteractions(inter.interactions || [])
      setTotal(inter.total || 0)
      setOffset(LIMIT)
      setCompanies(comps)
      return c
    }, [id])

  // Les libellés, les masquages et les champs perso viennent du registre commun
  // (custom_fields) : renommer ou supprimer un champ depuis un tableau se voit
  // ici aussi. La mise en page, elle, reste celle de la fiche.
  const baseFields = useMemo(() => CONTACT_FIELDS.filter(f => f.defaultVisible !== false), [])
  const { fields: visibleFields } = useDetailFields('contacts', baseFields)

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
    if (interactionRequest.current) return
    interactionRequest.current = true
    setLoadingMore(true)
    try {
      const res = await api.interactions.list({ contact_id: id, limit: LIMIT, offset, include: 'heavy' })
      setInteractions(prev => [...prev, ...(res.interactions || [])])
      setOffset(o => o + LIMIT)
    } catch {
      addToast({ message: 'Impossible de charger la suite du fil', type: 'error' })
    } finally {
      interactionRequest.current = false
      setLoadingMore(false)
    }
  }

  async function togglePinInteraction(item) {
    if (interactionRequest.current) return
    interactionRequest.current = true
    setLoadingMore(true)
    let saved = false
    try {
      const updated = await api.interactions.pin(item.id, !item.pinned)
      saved = true
      setInteractions(prev => [...prev].map(x => x.id === item.id ? { ...x, ...updated } : x)
        .sort((a, b) => (b.pinned - a.pinned) || (b.timestamp || '').localeCompare(a.timestamp || '')))
      // Désépingler une ancienne entrée peut la repousser hors des pages déjà
      // chargées. Relire cette fenêtre évite de sauter une entrée à la page suivante.
      const res = await api.interactions.list({ contact_id: id, limit: offset || LIMIT, offset: 0, include: 'heavy' })
      setInteractions(res.interactions || [])
      setTotal(res.total || 0)
      setOffset(res.interactions?.length || 0)
    } catch {
      addToast({ message: saved ? 'Épinglage enregistré. Actualisez le fil.' : "Échec de l'épinglage", type: 'error' })
    } finally {
      interactionRequest.current = false
      setLoadingMore(false)
    }
  }

  // Recharge la première page du fil (après un log manuel) : l'entrée neuve est
  // la plus récente, donc en tête.
  async function reloadInteractions() {
    const res = await api.interactions.list({ contact_id: id, limit: LIMIT, offset: 0, include: 'heavy' })
    setInteractions(res.interactions || [])
    setTotal(res.total || 0)
    setOffset(LIMIT)
  }

  useEffect(() => {
    api.tasks.list({ contact_id: id, limit: 'all' }).then(r => setTasks(r.data || [])).catch(() => {})
    api.auth.users().then(setUsers).catch(() => {})
  }, [id])

  const dismiss = () => onClose?.()

  useRealtimeChannel(id ? `contact:${id}` : null, (msg) => {
    if (msg.type === 'contact:updated') setContact(c => c ? { ...c, ...msg.payload } : c)
    else if (msg.type === 'contact:deleted') dismiss()
  })

  // Suppression du contact : confirmation, fermeture de la fiche, puis toast
  // « Annuler » de 8 s (soft-delete → restaurable, cf. lib/undoableDelete.js).
  async function handleDelete() {
    const name = `${contact?.first_name || ''} ${contact?.last_name || ''}`.trim()
    if (!(await confirm(name ? `Supprimer le contact ${name} ?` : 'Supprimer ce contact ?'))) return
    try {
      await undoableDelete({
        table: 'contacts',
        id,
        deleteFn: () => api.contacts.delete(id),
        label: 'Contact supprimé',
        onChange: () => { syncStore().catch(() => {}) },
      })
      dismiss()
    } catch (err) {
      addToast({ message: err.message || 'Erreur lors de la suppression', type: 'error' })
    }
  }

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

  function openNewTask() {
    setEditingTask(null)
    setTaskForm({ title: '', status: 'À faire', priority: 'Normal', due_date: '', assigned_to: user?.id || '', notes: '' })
    setShowTaskModal(true)
  }

  function openTask(row) {
    setEditingTask(row)
    setTaskForm({ title: row.title, status: row.status, priority: row.priority, due_date: row.due_date || '', assigned_to: row.assigned_to || '', notes: row.notes || '' })
    setShowTaskModal(true)
  }

  const pending = detailPending({ loading, loadError, onRetry: load, record: contact, notFound: 'Contact introuvable.' })
  if (pending) return pending

  return (
    <>
      <DetailShell
        header={{
          status: <SaveStatus status={saveState} />,
          actions: canDelete && (
            <button
              onClick={handleDelete}
              className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg"
              title="Supprimer ce contact"
              aria-label="Supprimer ce contact"
              data-testid="delete-contact"
            >
              <Trash2 size={16} />
            </button>
          ),
        }}
      >
        {/* Layout CRM : informations à gauche, fil des événements au centre,
            records liés à droite (cf. components/CrmDetailLayout.jsx). */}
        <CrmDetailLayout
          left={(
            <>
              {/* L'ordre des champs et ceux qu'on garde se règlent dans la fiche
                 elle-même (bouton « Personnaliser les champs » du panneau
                 latéral, ou au survol de la carte ici). */}
              <DetailFieldGrid entityType="contacts" record={contact} className="card p-4">
                {visibleFields.map(field => (
                  <DetailField
                    key={field.key}
                    id={field.key}
                    label={field.label}
                    span2={field.span2 || field.type === 'textarea'}
                    saving={!!fieldSaving[field.key]}
                  >
                    <InlineField
                      field={field}
                      value={contact[field.key] ?? ''}
                      saving={!!fieldSaving[field.key]}
                      onSave={val => saveField(field.key, val)}
                    />
                  </DetailField>
                ))}
              </DetailFieldGrid>
              <EmailAttachments contactId={id} />
            </>
          )}
          center={(
            <>
              <div className="flex items-center justify-between gap-2">
                <CrmCenterTabs
                  tabs={[
                    { key: 'fil', label: 'Fil', count: total },
                    ...(centerView === 'tâches' ? [{ key: 'tâches', label: 'Tâches', count: tasks.length }] : []),
                  ]}
                  active={centerView}
                  onSelect={setCenterView}
                />
                {centerView === 'fil' && (
                  <button onClick={() => setShowLogModal(true)} className="btn-secondary btn-sm" data-testid="log-interaction">
                    <Plus size={14} /> Consigner
                  </button>
                )}
              </div>
              {centerView === 'tâches' ? (
                <DataTable
                  table="contact_tasks"
                  columns={taskColumns}
                  data={tasks}
                  searchFields={['title', 'status']}
                  onRowClick={openTask}
                  height="320px"
                  emptyState={{ icon: CheckSquare, title: 'Aucune tâche', description: "Aucune tâche n'est associée à ce contact pour l'instant.", cta: { label: 'Ajouter', icon: Plus, onClick: openNewTask } }}
                />
              ) : (
                <InteractionTimeline
                  interactions={interactions}
                  total={total}
                  onLoadMore={loadMore}
                  loadingMore={loadingMore}
                  showContact={false}
                  onLog={() => setShowLogModal(true)}
                  onTogglePin={togglePinInteraction}
                />
              )}
            </>
          )}
          right={(
            <>
              <CrmCard
                title="Entreprises"
                count={(contact.companies || []).length}
                testId="crm-card-entreprises"
              >
                <CompanyLinks
                  contactId={id}
                  companies={contact.companies || []}
                  allCompanies={companies}
                  onChange={updated => setContact(c => ({ ...c, ...updated }))}
                />
              </CrmCard>

              <CrmCard
                title="Tâches"
                count={tasks.length}
                defaultOpen={tasks.length > 0}
                testId="crm-card-tâches"
                onOpen={() => setCenterView('tâches')}
                action={<CrmAdd onClick={openNewTask} label="Ajouter une tâche" />}
                footer={tasks.length > 5 ? (
                  <button
                    type="button"
                    onClick={e => { setCenterView('tâches'); scrollCrmToTop(e.currentTarget) }}
                    data-testid="crm-open-tâches"
                    className="mt-1 w-full px-2 py-1 rounded-lg text-left text-xs font-medium text-brand-600 hover:bg-brand-50"
                  >
                    Tout voir ({tasks.length})
                  </button>
                ) : null}
              >
                {tasks.length === 0 ? (
                  <div className="px-2 pb-1 text-sm text-slate-400">Aucune</div>
                ) : tasks.slice(0, 5).map(t => (
                  <CrmRow
                    key={t.id}
                    onClick={() => openTask(t)}
                    primary={t.title}
                    secondary={t.status}
                    meta={t.due_date ? fmtDateTime(t.due_date) : null}
                  />
                ))}
              </CrmCard>
            </>
          )}
        />
      </DetailShell>

      {showLogModal && (
        <LogInteractionModal
          contactId={id}
          companyId={(contact.companies || []).find(c => c.is_primary)?.company_id || (contact.companies || [])[0]?.company_id}
          onClose={() => setShowLogModal(false)}
          onSaved={reloadInteractions}
        />
      )}

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
