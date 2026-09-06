import { useState, useEffect, useCallback, useMemo } from 'react'
import { Trash2, ExternalLink, Plus, CheckCircle2, Circle, Clock, X, Star, MessageSquare, Phone, AlertTriangle, Copy } from 'lucide-react'
import api from '../lib/api.js'
import { useAuth } from '../lib/auth.jsx'
import { DetailShell, detailPending } from '../components/DetailShell.jsx'
import Spinner from '../components/Spinner.jsx'
import { Badge, ticketStatusColor } from '../components/Badge.jsx'
import InteractionTimeline from '../components/InteractionTimeline.jsx'
import Attachments from '../components/Attachments.jsx'
import LinkedRecordField from '../components/LinkedRecordField.jsx'
import { SearchableSelect } from '../components/SearchableSelect.jsx'
import { MultiSelectField } from '../components/MultiSelectField.jsx'
import { InlineText, InlineTextarea, InlineUrl } from '../components/InlineFields.jsx'
import { DetailFieldGrid, DetailField } from '../components/DetailFieldGrid.jsx'
import { useRealtimeChannel } from '../lib/useRealtimeChannel.js'
import { Modal } from '../components/Modal.jsx'
import TaskForm from '../components/TaskForm.jsx'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import WeatherPanel from '../components/WeatherPanel.jsx'
import { fmtDate, fmtDateTime } from '../lib/formatDate.js'
import { contactsForCompany } from '../lib/contactCompanies'
import { fmtPhone as fmtPhoneBase } from '../utils/formatters.js'
import { fmtDurationMinutes as fmtDuration } from '../lib/duration.js'


// requestIdleCallback avec fallback setTimeout pour browsers qui ne le supportent pas.
const scheduleIdle = (fn) => (typeof requestIdleCallback === 'function'
  ? requestIdleCallback(fn, { timeout: 500 })
  : setTimeout(fn, 0))
const cancelIdle = (h) => (typeof cancelIdleCallback === 'function'
  ? cancelIdleCallback(h)
  : clearTimeout(h))


// `onClose` ferme le drawer (utilisé après suppression du billet).
export default function TicketDetail({ recordId, onClose }) {
  const id = recordId
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


  // Modifié ailleurs (Airtable, un collègue) → la fiche suit sans rechargement.
  useRealtimeChannel(id ? `ticket:${id}` : null, (msg) => {
    if (msg.type === 'ticket:updated') setTicket(t => (t ? { ...t, ...msg.payload } : t))
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
      onClose?.()
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

  const pending = detailPending({ loading, loadError, onRetry: () => setReloadKey(k => k + 1), record: ticket, notFound: 'Billet introuvable.' })
  if (pending) return pending

  return (
    <>
      <DetailShell
        header={{
          badge: (
            <>
              <Badge color={ticketStatusColor(ticket.status)}>{ticket.status}</Badge>
              {ticket.type && <Badge color="gray">{ticket.type}</Badge>}
              <OrishaLinks controllers={ticket.central_controllers} />
            </>
          ),
          actions: (
            <>
              <SurveySection ticketId={id} contactId={ticket.contact_id} onSent={() => setSurveyKey(k => k + 1)} />
              <button onClick={handleDelete} className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg" title="Supprimer">
                <Trash2 size={16} />
              </button>
            </>
          ),
        }}
      >
        <SurveyCard ticketId={id} refreshKey={surveyKey} />

        {/* Info card — la disposition des champs (ordre, champs retirés) est
            personnalisable : bouton « Personnaliser les champs » dans l'en-tête
            du panneau latéral, ou au survol de la carte sur la page pleine. */}
        <DetailFieldGrid entityType="tickets" record={ticket}>
            <DetailField id="title" label="Titre" span2 saving={fieldSaving.title}>
              <InlineText value={ticket.title} saving={!!fieldSaving.title} onSave={v => saveField('title', v)} />
            </DetailField>
            <DetailField id="status" label="Statut" saving={fieldSaving.status}>
              <SearchableSelect
                value={ticket.status || ''}
                options={(meta.statuses || []).map(s => ({ value: s, label: s }))}
                emptyOption="—"
                onChange={v => saveField('status', v)}
                className="input text-sm w-full"
                size="sm"
                disabled={!!fieldSaving.status}
                testId="ticket-field-status"
              />
            </DetailField>
            <DetailField id="type" label="Type" saving={fieldSaving.type}>
              <SearchableSelect
                value={ticket.type || ''}
                options={(meta.types || []).map(t => ({ value: t, label: t }))}
                emptyOption="—"
                onChange={v => saveField('type', v)}
                className="input text-sm w-full"
                size="sm"
                disabled={!!fieldSaving.type}
                testId="ticket-field-type"
              />
            </DetailField>
            <DetailField id="company_id" label="Entreprise" saving={fieldSaving.company_id}>
              <LinkedRecordField
                name="company_id"
                value={ticket.company_id}
                options={companiesForPicker}
                labelFn={c => c.name}
                getHref={c => `/companies/${c.id}`}
                saving={!!fieldSaving.company_id}
                onChange={v => saveField('company_id', v)}
              />
            </DetailField>
            <DetailField id="contact_id" label="Contact" saving={fieldSaving.contact_id}>
              <LinkedRecordField
                name="contact_id"
                value={ticket.contact_id}
                options={contactsForPicker}
                labelFn={c => `${c.first_name} ${c.last_name}`}
                getHref={c => `/contacts/${c.id}`}
                saving={!!fieldSaving.contact_id}
                onChange={v => saveField('contact_id', v)}
              />
            </DetailField>
            <DetailField id="assigned_to" label="Assigne a" saving={fieldSaving.assigned_to}>
              <LinkedRecordField
                name="assigned_to"
                value={ticket.assigned_to}
                options={usersForPicker}
                labelFn={u => u.name}
                saving={!!fieldSaving.assigned_to}
                onChange={v => saveField('assigned_to', v)}
              />
            </DetailField>
            <DetailField id="duration_minutes" label="Duree" saving={fieldSaving.duration_minutes}>
              <div className="flex items-center gap-2">
                <input type="number" min="0" value={ticket.duration_minutes || 0}
                  onChange={e => saveField('duration_minutes', parseInt(e.target.value) || 0)}
                  className="input text-sm w-24" disabled={!!fieldSaving.duration_minutes} />
                <span className="text-xs text-slate-400">{fmtDuration(ticket.duration_minutes)}</span>
              </div>
            </DetailField>
            <DetailField id="description" label="Question" span2 saving={fieldSaving.description}>
              <InlineTextarea value={ticket.description} saving={!!fieldSaving.description} onSave={v => saveField('description', v)} />
            </DetailField>
            <DetailField id="response" label="Réponse" span2 saving={fieldSaving.response}>
              <InlineTextarea value={ticket.response} saving={!!fieldSaving.response} onSave={v => saveField('response', v)} />
            </DetailField>
            <DetailField id="lien_issue_github" label="Lien GitHub" span2 saving={fieldSaving.lien_issue_github}>
              <InlineUrl value={ticket.lien_issue_github} saving={!!fieldSaving.lien_issue_github} onSave={v => saveField('lien_issue_github', v)} />
            </DetailField>
            <DetailField id="escalade" label="Escalade" saving={fieldSaving.escalade}>
              <InlineText value={ticket.escalade} saving={!!fieldSaving.escalade} onSave={v => saveField('escalade', v)} />
            </DetailField>
            <DetailField id="arbre_de_troubleshoot_utilise" label="Arbre de troubleshoot utilisé" saving={fieldSaving.arbre_de_troubleshoot_utilise}>
              <InlineText value={ticket.arbre_de_troubleshoot_utilise} saving={!!fieldSaving.arbre_de_troubleshoot_utilise} onSave={v => saveField('arbre_de_troubleshoot_utilise', v)} />
            </DetailField>
            {/* Sélection multiple : les mots-clés sont stockés en tableau JSON
                (même format que le sync Airtable et que la colonne du tableau). */}
            <DetailField id="mots_cles" label="Mots-clés" span2 saving={fieldSaving.mots_cles}>
              <MultiSelectField
                value={ticket.mots_cles}
                options={keywordOptions}
                saving={!!fieldSaving.mots_cles}
                onChange={v => saveField('mots_cles', v.length ? JSON.stringify(v) : '')}
                testId="ticket-mots-cles"
              />
            </DetailField>
            <DetailField id="documents" label="Documents" span2 saving={fieldSaving.documents}>
              <InlineTextarea value={ticket.documents} saving={!!fieldSaving.documents} onSave={v => saveField('documents', v)} />
            </DetailField>
            <DetailField id="items_retours" label="Items retour" span2 saving={fieldSaving.items_retours}>
              <InlineTextarea value={ticket.items_retours} saving={!!fieldSaving.items_retours} onSave={v => saveField('items_retours', v)} />
            </DetailField>
        </DetailFieldGrid>

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
            <div className="text-xs text-slate-400"><Spinner size="xs" label="Chargement…" /></div>
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
      </DetailShell>

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

// Fallback '—' propre à cette page (le canonique renvoie '' pour une valeur vide).
const fmtPhone = (e164) => fmtPhoneBase(e164) || '—'

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

