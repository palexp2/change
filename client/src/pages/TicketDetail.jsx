import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, Trash2, ChevronDown, ChevronUp, ExternalLink, Plus, CheckCircle2, Circle, Clock, X, Star, MessageSquare, Phone, AlertTriangle, Copy } from 'lucide-react'
import api from '../lib/api.js'
import { useAuth } from '../lib/auth.jsx'
import { Layout } from '../components/Layout.jsx'
import Spinner from '../components/Spinner.jsx'
import { Badge, ticketStatusColor } from '../components/Badge.jsx'
import InteractionTimeline from '../components/InteractionTimeline.jsx'
import Attachments from '../components/Attachments.jsx'
import LinkedRecordField from '../components/LinkedRecordField.jsx'
import { SearchableSelect } from '../components/SearchableSelect.jsx'
import { MultiSelectField } from '../components/MultiSelectField.jsx'
import { Modal } from '../components/Modal.jsx'
import TaskForm from '../components/TaskForm.jsx'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { DetailLoadError } from '../components/DetailLoadError.jsx'
import WeatherPanel from '../components/WeatherPanel.jsx'
import { useRecordKeyNav } from '../lib/useRecordKeyNav.js'
import { fmtDate, fmtDateTime } from '../lib/formatDate.js'
import { contactsForCompany } from '../lib/contactCompanies'


// requestIdleCallback avec fallback setTimeout pour browsers qui ne le supportent pas.
const scheduleIdle = (fn) => (typeof requestIdleCallback === 'function'
  ? requestIdleCallback(fn, { timeout: 500 })
  : setTimeout(fn, 0))
const cancelIdle = (h) => (typeof cancelIdleCallback === 'function'
  ? cancelIdleCallback(h)
  : clearTimeout(h))

function fmtDuration(mins) {
  if (!mins) return '—'
  const h = Math.floor(mins / 60), m = mins % 60
  return h === 0 ? `${m}m` : `${h}h${m > 0 ? m + 'm' : ''}`
}

// `recordId` + `embedded` permettent de monter cette fiche dans le side-peek
// (RecordPeekDrawer) sans le chrome de page (Layout, bouton retour, nav
// clavier prev/next). En mode route normale, l'`id` vient de l'URL.
// `onClose` ferme le drawer (utilisé après suppression du billet).
export default function TicketDetail({ recordId, embedded = false, onClose }) {
  const { id: paramId } = useParams()
  const id = recordId ?? paramId
  const navigate = useNavigate()
  const { user } = useAuth()
  const [ticket, setTicket] = useState(null)
  const [companies, setCompanies] = useState([])
  const [contacts, setContacts] = useState([])
  const [users, setUsers] = useState([])
  const [meta, setMeta] = useState({ types: [], statuses: [] })
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [surveyKey, setSurveyKey] = useState(0)
  const [fieldSaving, setFieldSaving] = useState({})
  const [ticketIds, setTicketIds] = useState([])
  const [keywordOptions, setKeywordOptions] = useState([])
  const [linkedInteractions, setLinkedInteractions] = useState([])
  const [interactionsTotal, setInteractionsTotal] = useState(0)
  const [interactionsOffset, setInteractionsOffset] = useState(0)
  const [loadingInteractions, setLoadingInteractions] = useState(false)
  const [loadingMoreInteractions, setLoadingMoreInteractions] = useState(false)
  const INTER_LIMIT = 30
  const [linkedTasks, setLinkedTasks] = useState([])
  const [loadingTasks, setLoadingTasks] = useState(false)
  const [showTaskModal, setShowTaskModal] = useState(false)
  const [editingTask, setEditingTask] = useState(null)
  const confirm = useConfirm()
  const { addToast } = useToast()

  const loadTasks = useCallback((signal) => {
    setLoadingTasks(true)
    api.tasks.list({ ticket_id: id, limit: 'all' }, signal)
      .then(r => setLinkedTasks(r.data || []))
      .catch(err => { if (err.name !== 'AbortError') setLinkedTasks([]) })
      .finally(() => { if (!signal?.aborted) setLoadingTasks(false) })
  }, [id])

  // Tasks: déclenché après que le ticket soit chargé ET peint, pour ne pas
  // entrer en compétition avec ticket.get sur les 6 connexions concurrentes.
  useEffect(() => {
    if (!ticket?.id) return
    const ac = new AbortController()
    const handle = scheduleIdle(() => { if (!ac.signal.aborted) loadTasks(ac.signal) })
    return () => { cancelIdle(handle); ac.abort() }
  }, [ticket?.id, loadTasks])

  useEffect(() => {
    api.tickets.ids()
      .then(ids => setTicketIds(ids || []))
      .catch(() => {})
  }, [])

  // Options du champ « Mots clés » : dérivées des valeurs déjà utilisées sur les
  // billets (le champ vient d'Airtable, sans liste de choix côté ERP).
  useEffect(() => {
    api.tickets.keywords()
      .then(k => setKeywordOptions(Array.isArray(k) ? k : []))
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!ticket?.company_id) {
      setLinkedInteractions([])
      setInteractionsTotal(0)
      setInteractionsOffset(0)
      return
    }
    const ac = new AbortController()
    setLoadingInteractions(true)
    // Idle scheduling : laisse le navigateur peindre le ticket avant de lancer
    // la requête interactions (qui est la plus volumineuse de la page).
    const handle = scheduleIdle(() => {
      if (ac.signal.aborted) return
      api.interactions.list({ company_id: ticket.company_id, limit: INTER_LIMIT, offset: 0, include: 'heavy' }, ac.signal)
        .then(d => {
          setLinkedInteractions(d.interactions || [])
          setInteractionsTotal(d.total || 0)
          setInteractionsOffset(INTER_LIMIT)
        })
        .catch(err => { if (err.name !== 'AbortError') setLinkedInteractions([]) })
        .finally(() => { if (!ac.signal.aborted) setLoadingInteractions(false) })
    })
    return () => { cancelIdle(handle); ac.abort() }
  }, [ticket?.company_id])

  async function loadMoreInteractions() {
    if (!ticket?.company_id) return
    setLoadingMoreInteractions(true)
    try {
      const d = await api.interactions.list({ company_id: ticket.company_id, limit: INTER_LIMIT, offset: interactionsOffset, include: 'heavy' })
      setLinkedInteractions(prev => [...prev, ...(d.interactions || [])])
      setInteractionsOffset(o => o + INTER_LIMIT)
    } finally {
      setLoadingMoreInteractions(false)
    }
  }

  const currentIdx = ticketIds.indexOf(id)
  const prevId = currentIdx > 0 ? ticketIds[currentIdx - 1] : null
  const nextId = currentIdx >= 0 && currentIdx < ticketIds.length - 1 ? ticketIds[currentIdx + 1] : null

  // Navigation clavier entre billets (j/↓ suivant · k/↑ précédent).
  // Désactivée en mode embarqué : naviguer quitterait le drawer.
  useRecordKeyNav({
    prev: !embedded && prevId ? `/tickets/${prevId}` : null,
    next: !embedded && nextId ? `/tickets/${nextId}` : null,
  })

  useEffect(() => {
    const ac = new AbortController()
    async function load() {
      setLoading(true)
      setLoadError(null)
      try {
        const [t, m] = await Promise.all([
          api.tickets.get(id, ac.signal),
          api.tickets.meta(),
        ])
        if (ac.signal.aborted) return
        setTicket(t)
        setMeta(m)
      } catch (err) {
        if (err.name === 'AbortError') return
        setLoadError(err?.message || 'Erreur de chargement')
      } finally {
        if (!ac.signal.aborted) setLoading(false)
      }
      // Lookups en arrière-plan — cachés 30s, non annulés (partagés entre pages).
      api.companies.lookup().then(setCompanies).catch(() => {})
      api.contacts.lookup().then(setContacts).catch(() => {})
      api.admin.listUsers().then(setUsers).catch(() => {})
    }
    load()
    return () => ac.abort()
  }, [id, reloadKey])

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
    try {
      await api.tickets.delete(id)
      if (embedded) onClose?.()
      else navigate('/tickets')
    } catch (err) {
      addToast({ message: err.message || 'Erreur lors de la suppression', type: 'error' })
    }
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

  const filteredContacts = contactsForCompany(contacts, ticket?.company_id)

  // Seed pickers avec un placeholder dérivé du ticket joint pour que le label
  // s'affiche immédiatement, avant l'arrivée des lookups en arrière-plan.
  const companiesForPicker = useMemo(() => {
    if (!ticket?.company_id) return companies
    if (companies.some(c => c.id === ticket.company_id)) return companies
    return [...companies, { id: ticket.company_id, name: ticket.company_name || '…' }]
  }, [companies, ticket?.company_id, ticket?.company_name])

  const contactsForPicker = useMemo(() => {
    if (!ticket?.contact_id) return filteredContacts
    if (filteredContacts.some(c => c.id === ticket.contact_id)) return filteredContacts
    const [first, ...rest] = (ticket.contact_name || '').split(' ')
    return [...filteredContacts, { id: ticket.contact_id, first_name: first || '…', last_name: rest.join(' '), company_id: ticket.company_id }]
  }, [filteredContacts, ticket?.contact_id, ticket?.contact_name, ticket?.company_id])

  const usersForPicker = useMemo(() => {
    if (!ticket?.assigned_to) return users
    if (users.some(u => u.id === ticket.assigned_to)) return users
    return [...users, { id: ticket.assigned_to, name: ticket.assigned_name || '…' }]
  }, [users, ticket?.assigned_to, ticket?.assigned_name])

  // En mode embarqué (side-peek), pas de Layout — le drawer fournit son propre
  // chrome. Sinon, page pleine classique.
  const shell = (content) => (embedded ? content : <Layout>{content}</Layout>)

  if (loading) {
    return shell(<Spinner center />)
  }
  if (loadError && !ticket) {
    return shell(<DetailLoadError message={loadError} onRetry={() => setReloadKey(k => k + 1)} />)
  }
  if (!ticket) {
    return shell(<div className="p-6 text-slate-500">Billet introuvable.</div>)
  }

  return shell(
    <>
      <div className={embedded ? 'px-5 py-4' : 'p-6 max-w-3xl mx-auto'}>
        {/* Header */}
        <div className="flex items-start gap-4 mb-6">
          {!embedded && (
            <button onClick={() => navigate('/tickets')} className="mt-1 p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg">
              <ArrowLeft size={18} />
            </button>
          )}
          <div className="flex-1">
            {!embedded && <h1 className="text-2xl font-bold text-slate-900">{ticket.title}</h1>}
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <Badge color={ticketStatusColor(ticket.status)}>{ticket.status}</Badge>
              {ticket.type && <Badge color="gray">{ticket.type}</Badge>}
              <OrishaLinks controllers={ticket.central_controllers} />
            </div>
          </div>
          <SurveySection ticketId={id} contactId={ticket.contact_id} onSent={() => setSurveyKey(k => k + 1)} />
          {!embedded && (
            <div className="flex items-center gap-1">
              <button
                onClick={() => prevId && navigate(`/tickets/${prevId}`)}
                disabled={!prevId}
                className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed"
                title="Billet précédent (k / ↑)"
              >
                <ChevronUp size={16} />
              </button>
              <button
                onClick={() => nextId && navigate(`/tickets/${nextId}`)}
                disabled={!nextId}
                className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed"
                title="Billet suivant (j / ↓)"
              >
                <ChevronDown size={16} />
              </button>
            </div>
          )}
          <button onClick={handleDelete} className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg" title="Supprimer">
            <Trash2 size={16} />
          </button>
        </div>

        <SurveyCard ticketId={id} refreshKey={surveyKey} />

        {/* Info card */}
        <div className="card p-5 mb-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4 text-sm">
            <div className="sm:col-span-2">
              <FieldLabel label="Titre" saving={fieldSaving.title} />
              <InlineText value={ticket.title} saving={!!fieldSaving.title} onSave={v => saveField('title', v)} />
            </div>
            <div>
              <FieldLabel label="Statut" saving={fieldSaving.status} />
              <SearchableSelect
                value={ticket.status || ''}
                options={(meta.statuses || []).map(s => ({ value: s, label: s }))}
                emptyOption="—"
                placeholder="—"
                onChange={v => saveField('status', v)}
                className="input text-sm w-full"
                size="sm"
                disabled={!!fieldSaving.status}
                testId="ticket-field-status"
              />
            </div>
            <div>
              <FieldLabel label="Type" saving={fieldSaving.type} />
              <SearchableSelect
                value={ticket.type || ''}
                options={(meta.types || []).map(t => ({ value: t, label: t }))}
                emptyOption="—"
                placeholder="—"
                onChange={v => saveField('type', v)}
                className="input text-sm w-full"
                size="sm"
                disabled={!!fieldSaving.type}
                testId="ticket-field-type"
              />
            </div>
            <div>
              <FieldLabel label="Entreprise" saving={fieldSaving.company_id} />
              <LinkedRecordField
                name="company_id"
                value={ticket.company_id}
                options={companiesForPicker}
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
                options={contactsForPicker}
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
                options={usersForPicker}
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
              {/* Sélection multiple : les mots-clés sont stockés en tableau JSON
                  (même format que le sync Airtable et que la colonne du tableau). */}
              <MultiSelectField
                value={ticket.mots_cles}
                options={keywordOptions}
                saving={!!fieldSaving.mots_cles}
                onChange={v => saveField('mots_cles', v.length ? JSON.stringify(v) : '')}
                placeholder="Ajouter un mot-clé"
                testId="ticket-mots-cles"
              />
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

        {/* Météo au site — conditions à l'adresse du client autour de l'ouverture du billet */}
        <div className="mb-6">
          <WeatherPanel companyId={ticket.company_id} at={ticket.created_at} markerLabel="Ouverture du billet" />
        </div>

        {/* Meta */}
        <div className="text-xs text-slate-400 flex gap-4">
          <span>Cree: {fmtDateTime(ticket.created_at)}</span>
          {ticket.updated_at && <span>Modifie: {fmtDateTime(ticket.updated_at)}</span>}
        </div>

        {/* Pièces jointes */}
        <div className="mt-8">
          <Attachments entityType="tickets" entityId={id} />
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
              total={interactionsTotal}
              onLoadMore={interactionsOffset < interactionsTotal ? loadMoreInteractions : undefined}
              loadingMore={loadingMoreInteractions}
            />
          </div>
        )}
      </div>

      <Modal isOpen={showTaskModal} title="Nouvelle tâche" onClose={() => setShowTaskModal(false)}>
        <TaskForm
          companies={companies}
          contacts={contactsForCompany(contacts, ticket?.company_id)}
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
    </>
  )
}

// ---------------------------------------------------------------------------
// Sondage de satisfaction par SMS
// ---------------------------------------------------------------------------

function fmtPhone(e164) {
  const d = String(e164 || '').replace(/\D/g, '')
  const local = d.length === 11 && d.startsWith('1') ? d.slice(1) : d
  if (local.length !== 10) return e164 || '—'
  return `(${local.slice(0, 3)}) ${local.slice(3, 6)}-${local.slice(6)}`
}

function Stars({ n, size = 15 }) {
  return (
    <span className="inline-flex items-center gap-0.5 align-middle">
      {[1, 2, 3, 4, 5].map(i => (
        <Star key={i} size={size} strokeWidth={1.5}
              className={i <= n ? 'text-amber-400' : 'text-slate-200'}
              fill={i <= n ? 'currentColor' : 'none'} />
      ))}
    </span>
  )
}

const SEND_STATUS_LABEL = {
  pending: 'En attente',
  sent: 'Envoyé',
  delivered: 'Livré',
  failed: 'Échec de livraison',
}

// Bouton + modale + encart de résultat. Un seul composant : les trois vues
// partagent le même état serveur, les séparer forcerait à le recharger deux fois.
function SurveySection({ ticketId, contactId, onSent }) {
  const { addToast } = useToast()
  const [state, setState] = useState(null)     // { eligibility, survey, survey_url }
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(false)
  const [phone, setPhone] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try { setState(await api.tickets.survey(ticketId)) }
    catch { /* silencieux : le sondage n'est pas la raison d'être de la page */ }
    finally { setLoading(false) }
    // L'éligibilité dépend du contact (numéro de téléphone) : la recharger
    // quand le contact du billet change, sinon le bouton reste bloqué après
    // l'ajout d'un contact tant que la page n'est pas rechargée.
  }, [ticketId, contactId])

  useEffect(() => { load() }, [load])

  const elig = state?.eligibility
  const survey = state?.survey
  const alreadySent = !!survey?.sent_at
  // Un envoi précédemment échoué ne doit pas bloquer : c'est justement le cas
  // où l'on veut corriger le numéro et réessayer.
  const canSend = !!elig?.eligible || (!!elig && elig.reason === 'Aucun numéro de téléphone pour ce contact')

  function openModal() {
    setPhone(survey?.phone || elig?.phone || '')
    setError(null)
    setOpen(true)
  }

  async function send() {
    setSending(true)
    setError(null)
    try {
      const res = await api.tickets.sendSurvey(ticketId, phone || null)
      setState(s => ({ ...s, survey: res.survey, survey_url: res.survey_url }))
      setOpen(false)
      addToast({
        message: res.simulated
          ? 'Sondage enregistré (SMS simulé — Telnyx non configuré)'
          : `Sondage envoyé au ${fmtPhone(res.survey.phone)}`,
        type: 'success',
      })
      onSent?.()
    } catch (err) {
      setError(err.message || "Échec de l'envoi")
    } finally {
      setSending(false)
    }
  }

  if (loading) return null

  return (
    <>
      <button
        onClick={openModal}
        disabled={!canSend}
        title={canSend
          ? (alreadySent ? 'Renvoyer le sondage de satisfaction par SMS' : 'Envoyer un sondage de satisfaction par SMS')
          : elig?.reason || 'Envoi impossible'}
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-sm text-slate-600 hover:text-brand-700 hover:bg-brand-50 rounded-lg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-slate-600 disabled:cursor-not-allowed"
        data-testid="ticket-survey-button"
      >
        <MessageSquare size={16} />
        <span className="hidden sm:inline">{alreadySent ? 'Renvoyer le sondage' : 'Sondage'}</span>
      </button>

      {open && (
        <Modal isOpen title={alreadySent ? 'Renvoyer le sondage de satisfaction' : 'Sondage de satisfaction'} onClose={() => setOpen(false)}>
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              Un message texte sera envoyé à <strong>{elig?.contact_name || 'ce contact'}</strong> avec un lien
              vers le sondage, en <strong>{elig?.language === 'English' ? 'anglais' : 'français'}</strong>.
            </p>

            <div>
              <label className="label">Numéro de téléphone</label>
              <input
                value={phone}
                onChange={e => setPhone(e.target.value)}
                placeholder="(514) 555-1234"
                className="input w-full"
                data-testid="ticket-survey-phone"
              />
              <p className="text-xs text-slate-400 mt-1">
                {elig?.phone_source === 'phone'
                  ? "Aucun cellulaire au dossier — c'est le téléphone fixe qui est proposé."
                  : 'Modifiable pour un envoi ponctuel : la fiche du contact n\'est pas touchée.'}
              </p>
            </div>

            {alreadySent && (
              <div className="flex gap-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-2.5">
                <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                <span>
                  Un sondage a déjà été envoyé le {fmtDate(survey.sent_at)}. Le renvoi réutilise le même lien —
                  une réponse déjà donnée reste enregistrée.
                </span>
              </div>
            )}

            {error && <p className="text-sm text-red-600">{error}</p>}

            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setOpen(false)} className="btn-secondary">Annuler</button>
              {/* Action sortante irréversible (un SMS parti ne se rappelle pas) :
                  bouton explicite plutôt qu'autosave, conformément à l'exception
                  prévue par la règle « autosave partout ». */}
              <button onClick={send} disabled={sending || !phone.trim()} className="btn-primary" data-testid="ticket-survey-send">
                {sending ? 'Envoi…' : alreadySent ? 'Renvoyer' : 'Envoyer'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}

// Encart de résultat — n'apparaît que si un sondage existe pour ce billet.
function SurveyCard({ ticketId, refreshKey }) {
  const { addToast } = useToast()
  const [state, setState] = useState(null)

  useEffect(() => {
    api.tickets.survey(ticketId).then(setState).catch(() => {})
  }, [ticketId, refreshKey])

  const s = state?.survey
  if (!s) return null

  const failed = s.send_status === 'failed'
  const answered = !!s.responded_at

  return (
    <div className="card p-5 mb-6" data-testid="ticket-survey-card">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-slate-700">Sondage de satisfaction</h2>
        <span className={`text-xs ${failed ? 'text-red-600' : 'text-slate-400'}`}>
          {SEND_STATUS_LABEL[s.send_status] || s.send_status}
          {s.sent_at && ` le ${fmtDateTime(s.sent_at)}`}
          {s.send_count > 1 && ` · ${s.send_count} envois`}
        </span>
      </div>

      {failed && s.send_error && (
        <p className="text-xs text-red-600 mb-3">{s.send_error}</p>
      )}

      {answered ? (
        <div className="space-y-2.5">
          <div className="flex items-center gap-2.5">
            <Stars n={s.rating} size={18} />
            <span className="text-sm text-slate-500">{s.rating}/5</span>
            <span className="text-xs text-slate-400">· répondu le {fmtDateTime(s.responded_at)}</span>
            {s.response_count > 1 && (
              <span className="text-xs text-amber-600">· modifié {s.response_count - 1}×</span>
            )}
          </div>
          {s.accepts_call === 1 && (
            <div className="flex items-center gap-1.5 text-sm text-emerald-700">
              <Phone size={14} /> Accepte d'être contacté par téléphone
            </div>
          )}
          {s.accepts_call === 0 && (
            <div className="text-sm text-slate-400">Ne souhaite pas être contacté par téléphone</div>
          )}
          {s.comment && (
            <p className="text-sm text-slate-700 bg-slate-50 border border-slate-100 rounded-lg p-3 whitespace-pre-wrap">
              « {s.comment} »
            </p>
          )}
        </div>
      ) : (
        <p className="text-sm text-slate-400">
          Envoyé au {fmtPhone(s.phone)} — en attente de réponse.
        </p>
      )}

      {state.survey_url && (
        <button
          onClick={() => {
            navigator.clipboard?.writeText(state.survey_url)
            addToast({ message: 'Lien du sondage copié', type: 'success' })
          }}
          className="mt-3 inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-brand-600"
        >
          <Copy size={12} /> Copier le lien du sondage
        </button>
      )}
    </div>
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
