import { useMemo, useState } from 'react'
import { Phone, Mail, MessageSquare, Users, FileText, Trash2 } from 'lucide-react'
import api from '../lib/api.js'
import EmailBodyFrame from '../components/EmailBodyFrame.jsx'
import EmailAttachments from '../components/EmailAttachments.jsx'
import { looksLikeHtml } from '../lib/emailDoc.js'
import { stripEmailHtml, stripEmailText } from '../lib/emailParser.js'
import { Badge, INTERACTION_TYPE_LABELS as TYPE_LABELS } from '../components/Badge.jsx'
import { DetailShell, detailPending } from '../components/DetailShell.jsx'
import { useDetailRecord } from '../lib/useDetailRecord.js'
import { DetailFieldGrid, DetailField } from '../components/DetailFieldGrid.jsx'
import LinkedRecordField from '../components/LinkedRecordField.jsx'
import { fmtDateTime } from '../lib/formatDate.js'
import { fmtDurationSeconds as fmtDuration } from '../lib/duration.js'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { useUndoableDelete } from '../lib/undoableDelete.js'
import { useToast } from '../contexts/ToastContext.jsx'

// Type d'interaction : icône + couleurs, partagés avec la liste (/interactions).
export const INTERACTION_TYPE_ICONS = { call: Phone, email: Mail, sms: MessageSquare, meeting: Users, note: FileText }
export const INTERACTION_TYPE_COLORS = {
  call:    'bg-blue-100 text-blue-700',
  email:   'bg-purple-100 text-purple-700',
  sms:     'bg-green-100 text-green-700',
  meeting: 'bg-amber-100 text-amber-700',
  note:    'bg-slate-100 text-slate-600',
}
const DIRECTION_COLORS = { in: 'green', out: 'blue' }

export function InteractionTypePill({ type }) {
  const Icon = INTERACTION_TYPE_ICONS[type] || FileText
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-medium ${INTERACTION_TYPE_COLORS[type] || 'bg-slate-100 text-slate-600'}`}>
      <Icon size={12} />
      {TYPE_LABELS[type] || type}
    </span>
  )
}

// Bloc de contenu long (enregistrement, transcription, corps d'un courriel…) :
// ce ne sont pas des champs de `interactions`, ils viennent des tables de
// détail (calls, emails, meetings).
function Block({ label, children }) {
  return (
    <div>
      <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-1.5">{label}</div>
      {children}
    </div>
  )
}

const boxClass = 'p-3 bg-slate-50 rounded-lg text-sm text-slate-700 whitespace-pre-wrap border border-slate-200'

export default function InteractionDetail({ recordId: id, onClose }) {
  const confirm = useConfirm()
  const undoableDelete = useUndoableDelete()
  const { addToast } = useToast()

  const [showFull, setShowFull] = useState(false)

  const { record: item, loading, loadError, reload: load } =
    useDetailRecord(() => api.interactions.get(id), [id], { clearOnError: true })

  // Corps du courriel : du HTML se cache aussi dans la colonne texte (part
  // `text/plain` absente à l'envoi) — sans détection, la fiche affichait le
  // gabarit balise par balise. Le HTML part dans une iframe sandboxée, le texte
  // brut garde sa boîte.
  const emailBody = useMemo(() => {
    if (item?.type !== 'email') return null
    const raw = item.body_html || (looksLikeHtml(item.body_text) ? item.body_text : null)
    if (raw) {
      const { html, hasHidden } = stripEmailHtml(raw)
      if (showFull || html.trim()) return { kind: 'html', html: showFull ? raw : html, hasHidden }
    }
    if (item.body_text) {
      const { text, hasHidden } = stripEmailText(item.body_text)
      return { kind: 'text', text: showFull ? item.body_text : text, hasHidden }
    }
    return null
  }, [item, showFull])

  async function handleDelete() {
    if (!(await confirm('Supprimer cette interaction ?'))) return
    try {
      await undoableDelete({
        table: 'interactions',
        id,
        deleteFn: () => api.interactions.delete(id),
        label: 'Interaction supprimée',
      })
      onClose?.()
    } catch (err) {
      addToast({ message: err.message || 'Erreur lors de la suppression', type: 'error' })
    }
  }

  const pending = detailPending({ loading, loadError, onRetry: load, record: item, notFound: 'Interaction introuvable.' })
  if (pending) return pending

  const Icon = INTERACTION_TYPE_ICONS[item.type] || FileText
  const contactName = item.contact_name?.trim()

  return (
    <DetailShell
      header={{
        leading: (
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${INTERACTION_TYPE_COLORS[item.type] || 'bg-slate-100 text-slate-600'}`}>
            <Icon size={18} />
          </div>
        ),
        badge: <InteractionTypePill type={item.type} />,
        status: item.direction && (
          <Badge color={DIRECTION_COLORS[item.direction]}>{item.direction === 'in' ? 'Entrant' : 'Sortant'}</Badge>
        ),
        meta: item.user_name && <span>Enregistré par {item.user_name}</span>,
        actions: (
          <button
            onClick={handleDelete}
            className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg"
            title="Supprimer cette interaction"
            aria-label="Supprimer cette interaction"
            data-testid="delete-interaction"
          >
            <Trash2 size={16} />
          </button>
        ),
      }}
    >
      <div className="card p-5 space-y-5">
        {/* Carte de champs commune : une seule liste, réordonnable et masquable
            depuis la fiche (bouton « Personnaliser les champs »). Les champs
            propres à un TYPE d'interaction (numéro appelé, sujet d'un courriel…)
            ne sont posés que pour ce type — ils n'ont pas de sens ailleurs ;
            c'est la seule condition qui reste, la présence choisie par
            l'utilisateur est gérée par la carte. */}
        <DetailFieldGrid
          entityType="interactions"
          record={item}
          className=""
          testId="interaction-fields"
        >
          <DetailField id="contact_name" label="Contact">
            {item.contact_id
              ? <LinkedRecordField
                  name="contact_id"
                  value={item.contact_id}
                  options={[{ id: item.contact_id, name: contactName }]}
                  getHref={c => `/contacts/${c.id}`}
                  disabled
                  allowClear={false}
                />
              : <div className="text-sm text-slate-900">{contactName || <span className="text-slate-400">—</span>}</div>}
          </DetailField>

          <DetailField id="company_name" label="Entreprise">
            {item.company_id
              ? <LinkedRecordField
                  name="company_id"
                  value={item.company_id}
                  options={[{ id: item.company_id, name: item.company_name }]}
                  getHref={c => `/companies/${c.id}`}
                  disabled
                  allowClear={false}
                />
              : <div className="text-sm text-slate-900">{item.company_name || <span className="text-slate-400">—</span>}</div>}
          </DetailField>

          <DetailField id="timestamp" label="Date">
            <div className="text-sm text-slate-900">{fmtDateTime(item.timestamp)}</div>
          </DetailField>

          {item.type === 'call' && (
            <DetailField id="phone_number" label="Numéro">
              <div className="text-sm text-slate-900 font-mono">{item.callee_number || <span className="text-slate-400 font-sans">—</span>}</div>
            </DetailField>
          )}
          {item.type === 'call' && (
            <DetailField id="duration_seconds" label="Durée">
              <div className="text-sm text-slate-900">{item.duration_seconds ? fmtDuration(item.duration_seconds) : <span className="text-slate-400">—</span>}</div>
            </DetailField>
          )}

          {item.type === 'email' && (
            <DetailField id="subject" label="Sujet" span2>
              <div className="text-sm text-slate-900">{item.subject || <span className="text-slate-400">—</span>}</div>
            </DetailField>
          )}
          {item.type === 'email' && (
            <DetailField id="from_address" label="De">
              <div className="text-sm text-slate-900 font-mono text-xs">{item.from_address || <span className="text-slate-400 font-sans text-sm">—</span>}</div>
            </DetailField>
          )}
          {item.type === 'email' && (
            <DetailField id="to_address" label="À">
              <div className="text-sm text-slate-900 font-mono text-xs">{item.to_address || <span className="text-slate-400 font-sans text-sm">—</span>}</div>
            </DetailField>
          )}

          {(item.type === 'meeting' || item.type === 'note') && (
            <DetailField id="meeting_title" label="Titre" span2>
              <div className="text-sm text-slate-900">
                {item.meeting_title && item.meeting_title !== 'Note'
                  ? item.meeting_title
                  : <span className="text-slate-400">—</span>}
              </div>
            </DetailField>
          )}
          {(item.type === 'meeting' || item.type === 'note') && (
            <DetailField id="duration_minutes" label="Durée">
              <div className="text-sm text-slate-900">
                {item.duration_minutes ? `${item.duration_minutes} min` : <span className="text-slate-400">—</span>}
              </div>
            </DetailField>
          )}
        </DetailFieldGrid>

        {/* Appel */}
        {item.type === 'call' && (
          <>
            {item.call_id && (item.recording_path || item.drive_file_id) && (
              <Block label="Enregistrement">
                <audio controls className="w-full h-10 rounded"
                  src={`/erp/api/calls/${item.call_id}/recording?token=${localStorage.getItem('erp_token')}`} />
              </Block>
            )}
            {item.transcription_status && item.transcription_status !== 'done' && (
              <Badge color="yellow">
                {item.transcription_status === 'pending' ? 'Transcription en attente' :
                 item.transcription_status === 'processing' ? 'Transcription en cours...' : 'Erreur transcription'}
              </Badge>
            )}
            {item.call_summary && (
              <Block label="Résumé">
                <div className={boxClass}>{item.call_summary}</div>
              </Block>
            )}
            {item.call_next_steps && (
              <Block label="Prochaines étapes">
                <div className={boxClass}>{item.call_next_steps}</div>
              </Block>
            )}
            {item.transcript_formatted && (
              <Block label="Transcription">
                <div className={`${boxClass} text-xs font-mono max-h-80 overflow-y-auto`}>{item.transcript_formatted}</div>
              </Block>
            )}
          </>
        )}

        {/* Courriel */}
        {emailBody && (
          <Block label="Contenu">
            {emailBody.kind === 'html'
              ? <div className="rounded-lg border border-slate-200 bg-white max-h-96 overflow-y-auto">
                  <EmailBodyFrame html={emailBody.html} />
                </div>
              : <div className={`${boxClass} max-h-80 overflow-y-auto`}>{emailBody.text}</div>}
            {emailBody.hasHidden && (
              <button onClick={() => setShowFull(v => !v)} className="mt-1.5 text-xs link-record">
                {showFull ? 'Masquer chaîne et signature' : 'Afficher chaîne et signature'}
              </button>
            )}
          </Block>
        )}

        {/* Pièces jointes du courriel : listées auprès de Gmail au premier
            accès à la fiche, le bloc s'efface s'il n'y en a aucune. */}
        {item.type === 'email' && (
          <EmailAttachments interactionId={id} embedded hideWhenEmpty />
        )}

        {/* Réunion / note */}
        {(item.type === 'meeting' || item.type === 'note') && item.meeting_notes && (
          <Block label="Notes">
            <div className={boxClass}>{item.meeting_notes}</div>
          </Block>
        )}
      </div>
    </DetailShell>
  )
}
