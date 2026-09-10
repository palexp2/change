import { useState, useEffect, useCallback, useMemo } from 'react'
import { Trash2, Plus, CheckCircle2, Circle, Clock, X, Star, MessageSquare, Phone, AlertTriangle, Copy } from 'lucide-react'
import api from '../lib/api.js'
import { useAuth } from '../lib/auth.jsx'
import { DetailShell, detailPending } from '../components/DetailShell.jsx'
import Spinner from '../components/Spinner.jsx'
import { Badge } from '../components/Badge.jsx'
import Attachments from '../components/Attachments.jsx'
import { SearchableSelect } from '../components/SearchableSelect.jsx'
import { MultiSelectField } from '../components/MultiSelectField.jsx'
import { InlineText, InlineTextarea, InlineUrl } from '../components/InlineFields.jsx'
import { DetailFieldGrid, DetailField } from '../components/DetailFieldGrid.jsx'
import { useCustomFields } from '../lib/useCustomFields.js'
import { LinkedRecordsValue } from '../lib/customFieldDisplay.jsx'
import { useRealtimeChannel } from '../lib/useRealtimeChannel.js'
import { Modal } from '../components/Modal.jsx'
import TaskForm from '../components/TaskForm.jsx'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { useRecordDeleteAllowed } from '../lib/detailFieldLayout.jsx'
import { fmtDate, fmtDateTime } from '../lib/formatDate.js'
import { fmtPhone as fmtPhoneBase } from '../utils/formatters.js'


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
  // « Suppression permise » : case du mode de personnalisation de la fiche.
  const canDelete = useRecordDeleteAllowed('tickets')
  const { user } = useAuth()
  const [ticket, setTicket] = useState(null)
  const [companies, setCompanies] = useState([])
  const [contacts, setContacts] = useState([])
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [surveyKey, setSurveyKey] = useState(0)
  const [fieldSaving, setFieldSaving] = useState({})
  const [keywordOptions, setKeywordOptions] = useState([])
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

  // Entreprise et contact d'un billet : plus de colonne native depuis la 040,
  // ce sont les deux champs LIEN venus d'Airtable (`cf_entreprise`,
  // `cf_contact`). Ils sont déclarés en dur dans la carte pour être visibles
  // d'office — une colonne de sync attend sinon dans « Ajouter un champ ».
  const { fields: ticketFields } = useCustomFields('tickets')
  const linkFields = useMemo(() => {
    const by = new Map((ticketFields || []).map(f => [f.column_name, f]))
    return { company: by.get('cf_entreprise') || null, contact: by.get('cf_contact') || null }
  }, [ticketFields])

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
        const t = await api.tickets.get(id, ac.signal)
        if (ac.signal.aborted) return
        setTicket(t)
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

  // Patch d'UNE colonne : envoyer le billet entier repousserait toutes ses
  // colonnes vers Airtable à chaque frappe, et le serveur refuse désormais en
  // 400 un body qui contient un champ importé en sens « import » seul.
  async function saveField(key, value) {
    setFieldSaving(s => ({ ...s, [key]: true }))
    try {
      const updated = await api.tickets.update(id, { [key]: value ?? null })
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

  const pending = detailPending({ loading, loadError, onRetry: () => setReloadKey(k => k + 1), record: ticket, notFound: 'Billet introuvable.' })
  if (pending) return pending

  return (
    <>
      <DetailShell
        header={{
          actions: (
            <>
              <SurveySection ticketId={id} onSent={() => setSurveyKey(k => k + 1)} />
              {canDelete && (
                <button onClick={handleDelete} className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg" title="Supprimer">
                  <Trash2 size={16} />
                </button>
              )}
            </>
          ),
        }}
      >
        <SurveyCard ticketId={id} refreshKey={surveyKey} />

        {/* Info card — la disposition des champs (ordre, champs retirés) est
            personnalisable : bouton « Personnaliser les champs » dans l'en-tête
            du panneau latéral, ou au survol de la carte sur la page pleine. */}
        <DetailFieldGrid
          entityType="tickets"
          record={ticket}
          onSaveCustom={saveField}
          savingKeys={fieldSaving}
          selectPills
        >
            {/* Entreprise / contact : pastille cliquable vers la fiche + picker
                recherchable (règle « champs référence » du CLAUDE.md). Le lien
                choisi repart vers Airtable — les deux colonnes sont déclarées
                dans WRITEBACK_MODULES.billets. */}
            <DetailField id="cf_entreprise" label="Entreprise" saving={fieldSaving.cf_entreprise}>
              <TicketLink field={linkFields.company} value={ticket.cf_entreprise} saving={!!fieldSaving.cf_entreprise} onSave={saveField} />
            </DetailField>
            <DetailField id="cf_contact" label="Contact" saving={fieldSaving.cf_contact}>
              <TicketLink field={linkFields.contact} value={ticket.cf_contact} saving={!!fieldSaving.cf_contact} onSave={saveField} />
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

        {/* Meta */}
        <div className="text-xs text-slate-400 flex gap-4">
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

      </DetailShell>

      <Modal isOpen={showTaskModal} title="Nouvelle tâche" onClose={() => setShowTaskModal(false)}>
        <TaskForm
          companies={companies}
          contacts={contacts}
          users={users}
          tickets={[{ id: ticket?.id }]}
          initial={{ ticket_id: ticket?.id || '' }}
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
            tickets={[{ id: ticket?.id }]}
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

// Champ lien de la fiche billet (entreprise, contact). `field` est la ligne
// custom_fields du champ : elle porte la table cible et l'identité des clés
// écrites (record ids Airtable ici) — sans elle, aucun picker n'est possible,
// d'où le tiret le temps que la liste des champs arrive.
function TicketLink({ field, value, saving, onSave }) {
  if (!field) return <span className="text-slate-400">—</span>
  return (
    <LinkedRecordsValue
      field={field}
      value={value}
      detail
      saving={saving}
      onChange={field.writable === false ? null : v => onSave(field.column_name, v)}
    />
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
function SurveySection({ ticketId, onSent }) {
  const { addToast } = useToast()
  const [state, setState] = useState(null)     // { eligibility, survey, survey_url }
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(false)
  const [phone, setPhone] = useState('')
  const [language, setLanguage] = useState('French')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try { setState(await api.tickets.survey(ticketId)) }
    catch { /* silencieux : le sondage n'est pas la raison d'être de la page */ }
    finally { setLoading(false) }
  }, [ticketId])

  useEffect(() => { load() }, [load])

  const elig = state?.eligibility
  const survey = state?.survey
  const alreadySent = !!survey?.sent_at

  // Un billet ne porte plus ni contact ni langue (migration 040) : les deux se
  // saisissent ici, pré-remplis par le sondage déjà parti le cas échéant.
  function openModal() {
    setPhone(survey?.phone || elig?.phone || '')
    setLanguage(survey?.language || elig?.language || 'French')
    setError(null)
    setOpen(true)
  }

  async function send() {
    setSending(true)
    setError(null)
    try {
      const res = await api.tickets.sendSurvey(ticketId, { phone: phone || null, language })
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
        title={alreadySent ? 'Renvoyer le sondage de satisfaction par SMS' : 'Envoyer un sondage de satisfaction par SMS'}
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-sm text-slate-600 hover:text-brand-700 hover:bg-brand-50 rounded-lg"
        data-testid="ticket-survey-button"
      >
        <MessageSquare size={16} />
        <span className="hidden sm:inline">{alreadySent ? 'Renvoyer le sondage' : 'Sondage'}</span>
      </button>

      {open && (
        <Modal isOpen title={alreadySent ? 'Renvoyer le sondage de satisfaction' : 'Sondage de satisfaction'} onClose={() => setOpen(false)}>
          <div className="space-y-4">
            <div>
              <label className="label">Numéro de téléphone</label>
              <input
                value={phone}
                onChange={e => setPhone(e.target.value)}
                className="input w-full"
                data-testid="ticket-survey-phone"
              />
            </div>

            <div>
              <label className="label">Langue</label>
              <SearchableSelect
                value={language}
                options={[{ value: 'French', label: 'Français' }, { value: 'English', label: 'Anglais' }]}
                onChange={setLanguage}
                className="input text-sm w-full"
                size="sm"
                testId="ticket-survey-language"
              />
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
              <button onClick={send} disabled={sending || !phone.trim() || !language} className="btn-primary" data-testid="ticket-survey-send">
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
