import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Phone, Mail, MessageSquare, PhoneIncoming, PhoneOutgoing, Zap, Eye, Edit2, Building2 } from 'lucide-react'
import { fmtDateTime } from '../lib/formatDate.js'
import { stripEmailHtml, stripEmailText } from '../lib/emailParser.js'
import { Modal } from './Modal.jsx'

const TYPE_LABELS = { call: 'Appel', email: 'Courriel', sms: 'SMS', meeting: 'Réunion', note: 'Note' }
const TYPE_ICONS = { call: Phone, email: Mail, sms: MessageSquare, meeting: Building2, note: Edit2 }
const TRANSCRIPT_PREVIEW_LEN = 1000

function fmtDuration(s) {
  if (!s) return null
  const m = Math.floor(s / 60), sec = s % 60
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`
}

function DateSeparator({ date }) {
  const label = new Date(date).toLocaleDateString('fr-CA', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  return (
    <div className="flex items-center gap-3 my-4">
      <div className="flex-1 h-px bg-slate-200" />
      <span className="text-xs font-medium text-slate-400 uppercase tracking-wide">{label}</span>
      <div className="flex-1 h-px bg-slate-200" />
    </div>
  )
}

// ─── Bubble (compact preview in the thread) ──────────────────────────────────

function Bubble({ item, showContact, onOpen }) {
  const isOut = item.direction === 'out'
  const Icon = TYPE_ICONS[item.type] || MessageSquare

  // Body preview : full stripped message for emails, truncated transcript for
  // calls, truncated notes for meetings/notes.
  const preview = useMemo(() => buildPreview(item), [item])

  const bubbleBg = isOut ? 'bg-brand-600 text-white' : 'bg-white text-slate-800 border border-slate-200'
  const metaColor = isOut ? 'text-brand-200' : 'text-slate-400'
  const linkColor = isOut ? 'text-brand-100 hover:text-white' : 'text-brand-600 hover:underline'

  return (
    <div className={`flex ${isOut ? 'justify-end' : 'justify-start'}`}>
      <div className="max-w-[80%] min-w-[220px]">
        <div
          onClick={() => onOpen(item)}
          className={`rounded-2xl px-4 py-2.5 ${bubbleBg} ${isOut ? 'rounded-br-md' : 'rounded-bl-md'} cursor-pointer transition-shadow hover:shadow-md`}
        >
          {/* Header : icon + type only */}
          <div className="flex items-center gap-2 mb-1">
            <Icon size={13} className={isOut ? 'text-brand-200' : 'text-slate-400'} />
            <span className={`text-xs font-semibold ${isOut ? 'text-brand-100' : 'text-slate-500'}`}>
              {TYPE_LABELS[item.type] || item.type}
            </span>
            {item.direction === 'in' && item.type === 'call' && <PhoneIncoming size={11} className={metaColor} />}
            {item.direction === 'out' && item.type === 'call' && <PhoneOutgoing size={11} className={metaColor} />}
            {item.automated === 1 && <Zap size={10} className={isOut ? 'text-brand-200' : 'text-brand-400'} title="Auto" />}
            {item.automated === 1 && item.open_count > 0 && (
              <span className={`inline-flex items-center gap-0.5 text-xs ${isOut ? 'text-brand-200' : 'text-green-600'}`} title={`Ouvert ${item.open_count}×`}>
                <Eye size={10} /> {item.open_count}
              </span>
            )}
          </div>

          {/* Contact link for company/ticket timelines where one thread can mix contacts */}
          {showContact && item.contact_name?.trim() && (
            <Link to={`/contacts/${item.contact_id}`} onClick={e => e.stopPropagation()} className={`text-xs font-medium ${linkColor} block mb-1`}>
              {item.contact_name.trim()}
            </Link>
          )}

          {/* Subject for emails, title for meetings/notes */}
          {preview.subject && (
            <div className={`text-sm font-medium mb-1 ${isOut ? 'text-white' : 'text-slate-800'}`}>
              {preview.subject}
            </div>
          )}

          {/* Body — full stripped message, or 1000-char truncated transcript/notes */}
          {preview.kind === 'html' && (
            <div className="mt-1 rounded-lg overflow-hidden border border-slate-200/40 bg-white">
              <iframe
                srcDoc={preview.html}
                sandbox="allow-same-origin"
                scrolling="no"
                className="w-full border-0"
                style={{ minHeight: '40px', pointerEvents: 'none' }}
                onLoad={e => {
                  try { e.target.style.height = e.target.contentDocument.body.scrollHeight + 'px' } catch {}
                }}
              />
            </div>
          )}
          {preview.kind === 'text' && (
            <div className={`text-sm mt-1 whitespace-pre-wrap break-words ${isOut ? 'text-brand-50' : 'text-slate-700'}`}>
              {preview.text}
              {preview.truncated && <span className={metaColor}> …</span>}
            </div>
          )}

          {/* Call duration inline when no transcript to preview */}
          {item.type === 'call' && !preview.kind && item.duration_seconds && (
            <div className={`text-xs ${metaColor} mt-0.5`}>{fmtDuration(item.duration_seconds)}</div>
          )}

          {/* Audio recording (calls only) */}
          {item.call_id && (item.recording_path || item.drive_file_id) && (
            <audio
              controls
              className="mt-2 w-full h-8"
              src={`/erp/api/calls/${item.call_id}/recording?token=${localStorage.getItem('erp_token')}`}
              onClick={e => e.stopPropagation()}
            />
          )}
        </div>

        <div className={`text-[10px] mt-1 px-2 ${metaColor} ${isOut ? 'text-right' : 'text-left'}`}>
          {fmtDateTime(item.timestamp)}
          {item.user_name && <span> · {item.user_name}</span>}
        </div>
      </div>
    </div>
  )
}

function buildPreview(item) {
  if (item.type === 'email') {
    const subject = item.subject || null
    if (item.body_html) {
      const { html } = stripEmailHtml(item.body_html)
      return { kind: 'html', html, subject }
    }
    if (item.body_text) {
      const { text } = stripEmailText(item.body_text)
      return { kind: 'text', text, truncated: false, subject }
    }
    return { subject }
  }
  if (item.type === 'call' && item.call_summary) {
    return { kind: 'text', text: item.call_summary, truncated: false }
  }
  if (item.type === 'call' && item.transcript_formatted) {
    const full = item.transcript_formatted
    if (full.length <= TRANSCRIPT_PREVIEW_LEN) return { kind: 'text', text: full, truncated: false }
    return { kind: 'text', text: full.slice(0, TRANSCRIPT_PREVIEW_LEN), truncated: true }
  }
  if ((item.type === 'meeting' || item.type === 'note') && item.meeting_notes) {
    const title = item.meeting_title && item.meeting_title !== 'Note' ? item.meeting_title : null
    const full = item.meeting_notes
    if (full.length <= TRANSCRIPT_PREVIEW_LEN) return { kind: 'text', text: full, truncated: false, subject: title }
    return { kind: 'text', text: full.slice(0, TRANSCRIPT_PREVIEW_LEN), truncated: true, subject: title }
  }
  return {}
}

// ─── Detail modal (all the content + metadata) ───────────────────────────────

function InteractionDetail({ item }) {
  const [showFull, setShowFull] = useState(false)

  const emailBody = useMemo(() => {
    if (item.type !== 'email') return null
    if (item.body_html) {
      const { html, hasHidden } = stripEmailHtml(item.body_html)
      return { html: showFull ? item.body_html : html, hasHidden, kind: 'html' }
    }
    if (item.body_text) {
      const { text, hasHidden } = stripEmailText(item.body_text)
      return { text: showFull ? item.body_text : text, hasHidden, kind: 'text' }
    }
    return null
  }, [item.type, item.body_html, item.body_text, showFull])

  return (
    <div className="space-y-4">
      {/* Metadata */}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-xs font-medium text-slate-400 uppercase tracking-wide self-center">Date</dt>
        <dd className="text-slate-800">{fmtDateTime(item.timestamp)}</dd>

        {item.direction && (<>
          <dt className="text-xs font-medium text-slate-400 uppercase tracking-wide self-center">Direction</dt>
          <dd className="text-slate-800">{item.direction === 'in' ? 'Entrant' : 'Sortant'}</dd>
        </>)}

        {item.contact_name?.trim() && (<>
          <dt className="text-xs font-medium text-slate-400 uppercase tracking-wide self-center">Contact</dt>
          <dd>{item.contact_id
            ? <Link to={`/contacts/${item.contact_id}`} className="text-brand-600 hover:underline">{item.contact_name.trim()}</Link>
            : <span className="text-slate-800">{item.contact_name.trim()}</span>}
          </dd>
        </>)}

        {item.company_name && (<>
          <dt className="text-xs font-medium text-slate-400 uppercase tracking-wide self-center">Entreprise</dt>
          <dd>{item.company_id
            ? <Link to={`/companies/${item.company_id}`} className="text-brand-600 hover:underline">{item.company_name}</Link>
            : <span className="text-slate-800">{item.company_name}</span>}
          </dd>
        </>)}

        {item.type === 'email' && item.subject && (<>
          <dt className="text-xs font-medium text-slate-400 uppercase tracking-wide self-center">Sujet</dt>
          <dd className="text-slate-800 font-medium">{item.subject}</dd>
        </>)}
        {item.type === 'email' && item.from_address && (<>
          <dt className="text-xs font-medium text-slate-400 uppercase tracking-wide self-center">De</dt>
          <dd className="text-slate-700 text-xs font-mono">{item.from_address}</dd>
        </>)}
        {item.type === 'email' && item.to_address && (<>
          <dt className="text-xs font-medium text-slate-400 uppercase tracking-wide self-center">À</dt>
          <dd className="text-slate-700 text-xs font-mono">{item.to_address}</dd>
        </>)}

        {item.type === 'call' && item.callee_number && (<>
          <dt className="text-xs font-medium text-slate-400 uppercase tracking-wide self-center">Numéro</dt>
          <dd className="text-slate-800 font-mono">{item.callee_number}</dd>
        </>)}
        {item.type === 'call' && item.duration_seconds != null && (<>
          <dt className="text-xs font-medium text-slate-400 uppercase tracking-wide self-center">Durée</dt>
          <dd className="text-slate-800">{fmtDuration(item.duration_seconds)}</dd>
        </>)}

        {item.user_name && (<>
          <dt className="text-xs font-medium text-slate-400 uppercase tracking-wide self-center">Enregistré par</dt>
          <dd className="text-slate-800">{item.user_name}</dd>
        </>)}
      </dl>

      {/* Audio */}
      {item.call_id && (item.recording_path || item.drive_file_id) && (
        <audio controls className="w-full h-10 rounded"
          src={`/erp/api/calls/${item.call_id}/recording?token=${localStorage.getItem('erp_token')}`} />
      )}

      {/* Full body */}
      {emailBody?.kind === 'html' && (
        <div className="rounded-lg overflow-hidden border border-slate-200 bg-white">
          <iframe srcDoc={emailBody.html} sandbox="allow-same-origin" scrolling="no"
            className="w-full border-0" style={{ minHeight: '200px' }}
            onLoad={e => { try { e.target.style.height = e.target.contentDocument.body.scrollHeight + 'px' } catch {} }} />
        </div>
      )}
      {emailBody?.kind === 'text' && (
        <div className="p-3 bg-slate-50 rounded-lg text-sm text-slate-700 whitespace-pre-wrap border border-slate-200">
          {emailBody.text}
        </div>
      )}
      {item.type === 'call' && item.call_summary && (
        <div>
          <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-1.5">Résumé</div>
          <div className="p-3 bg-slate-50 rounded-lg text-sm text-slate-700 whitespace-pre-wrap border border-slate-200">
            {item.call_summary}
          </div>
        </div>
      )}
      {item.type === 'call' && item.call_next_steps && (
        <div>
          <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-1.5">Prochaines étapes</div>
          <div className="p-3 bg-slate-50 rounded-lg text-sm text-slate-700 whitespace-pre-wrap border border-slate-200">
            {item.call_next_steps}
          </div>
        </div>
      )}
      {item.type === 'call' && item.transcript_formatted && (
        <div>
          <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-1.5">Transcription</div>
          <div className="p-3 bg-slate-50 rounded-lg text-xs text-slate-700 whitespace-pre-wrap font-mono max-h-96 overflow-y-auto border border-slate-200">
            {item.transcript_formatted}
          </div>
        </div>
      )}
      {(item.type === 'meeting' || item.type === 'note') && item.meeting_notes && (
        <div>
          <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-1.5">Notes</div>
          <div className="p-3 bg-slate-50 rounded-lg text-sm text-slate-700 whitespace-pre-wrap border border-slate-200">
            {item.meeting_notes}
          </div>
        </div>
      )}

      {emailBody?.hasHidden && (
        <button
          onClick={() => setShowFull(v => !v)}
          className="text-xs text-brand-600 hover:underline"
        >
          {showFull ? 'Masquer chaîne et signature' : 'Afficher chaîne et signature'}
        </button>
      )}
    </div>
  )
}

// ─── Timeline (the list + modal orchestration) ───────────────────────────────

export default function InteractionTimeline({ interactions, loading, total, onLoadMore, loadingMore, showContact = true }) {
  const [selected, setSelected] = useState(null)

  if (loading) {
    return <div className="flex justify-center py-10"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" /></div>
  }
  if (interactions.length === 0) {
    return <div className="card p-10 text-center text-slate-400">Aucune interaction</div>
  }

  let lastDate = null
  const elements = []
  for (const item of interactions) {
    const day = item.timestamp ? item.timestamp.slice(0, 10) : null
    if (day && day !== lastDate) {
      elements.push(<DateSeparator key={`date-${day}`} date={item.timestamp} />)
      lastDate = day
    }
    elements.push(<Bubble key={item.id} item={item} showContact={showContact} onOpen={setSelected} />)
  }

  return (
    <>
      <div className="space-y-2 py-2">
        {elements}
        {total != null && interactions.length < total && (
          <button onClick={onLoadMore} disabled={loadingMore} className="btn-secondary w-full mt-3">
            {loadingMore ? 'Chargement...' : `Charger plus (${total - interactions.length} restants)`}
          </button>
        )}
      </div>

      <Modal
        isOpen={!!selected}
        onClose={() => setSelected(null)}
        title={selected ? (TYPE_LABELS[selected.type] || selected.type) : ''}
        size="lg"
      >
        {selected && <InteractionDetail item={selected} />}
      </Modal>
    </>
  )
}
