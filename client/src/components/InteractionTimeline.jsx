import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Phone, Mail, MessageSquare, PhoneIncoming, PhoneOutgoing, Zap, Eye, Edit2, Building2 } from 'lucide-react'

const TYPE_LABELS = { call: 'Appel', email: 'Courriel', sms: 'SMS', meeting: 'Réunion', note: 'Note' }
const TYPE_ICONS = { call: Phone, email: Mail, sms: MessageSquare, meeting: Building2, note: Edit2 }

function fmtDate(d) {
  if (!d) return ''
  return new Date(d).toLocaleDateString('fr-CA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

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

function Bubble({ item, showContact }) {
  const [expanded, setExpanded] = useState(false)
  const isOut = item.direction === 'out'
  const Icon = TYPE_ICONS[item.type] || MessageSquare
  const hasBody = item.transcript_formatted || item.body_text || item.body_html || item.meeting_notes

  const bubbleBg = isOut ? 'bg-indigo-600 text-white' : 'bg-white text-slate-800 border border-slate-200'
  const metaColor = isOut ? 'text-indigo-200' : 'text-slate-400'
  const linkColor = isOut ? 'text-indigo-100 hover:text-white' : 'text-indigo-600 hover:underline'
  const expandColor = isOut ? 'text-indigo-200 hover:text-white' : 'text-indigo-600 hover:underline'

  // Summary line
  let summary = null
  if (item.type === 'email' && item.subject) summary = item.subject
  else if (item.type === 'call' && item.callee_number) summary = item.callee_number
  else if ((item.type === 'meeting' || item.type === 'note') && item.meeting_title && item.meeting_title !== 'Note') summary = item.meeting_title

  return (
    <div className={`flex ${expanded ? 'justify-stretch' : isOut ? 'justify-end' : 'justify-start'}`}>
      <div className={`${expanded ? 'w-full' : 'max-w-[75%]'} min-w-[200px]`}>
        <div className={`rounded-2xl px-4 py-2.5 ${bubbleBg} ${isOut ? 'rounded-br-md' : 'rounded-bl-md'}`}>
          {/* Header: icon + type + direction */}
          <div className="flex items-center gap-2 mb-1">
            <Icon size={13} className={isOut ? 'text-indigo-200' : 'text-slate-400'} />
            <span className={`text-xs font-semibold ${isOut ? 'text-indigo-100' : 'text-slate-500'}`}>
              {TYPE_LABELS[item.type] || item.type}
            </span>
            {item.direction === 'in' ? <PhoneIncoming size={11} className={metaColor} /> : item.direction === 'out' ? <PhoneOutgoing size={11} className={metaColor} /> : null}
            {item.automated === 1 && <Zap size={10} className={isOut ? 'text-indigo-200' : 'text-indigo-400'} title="Auto" />}
            {item.automated === 1 && item.open_count > 0 && (
              <span className={`inline-flex items-center gap-0.5 text-xs ${isOut ? 'text-indigo-200' : 'text-green-600'}`} title={`Ouvert ${item.open_count}×`}>
                <Eye size={10} /> {item.open_count}
              </span>
            )}
          </div>

          {/* Contact name if relevant */}
          {showContact && item.contact_name?.trim() && (
            <Link to={`/contacts/${item.contact_id}`} onClick={e => e.stopPropagation()} className={`text-xs font-medium ${linkColor} block mb-1`}>
              {item.contact_name.trim()}
            </Link>
          )}

          {/* Email from/to */}
          {item.type === 'email' && (
            <div className={`text-xs ${metaColor} mb-1 font-mono truncate`}>
              {item.from_address} → {item.to_address}
            </div>
          )}

          {/* Summary / Subject */}
          {summary && (
            <div className={`text-sm font-medium ${isOut ? 'text-white' : 'text-slate-800'}`}>
              {summary}
            </div>
          )}

          {/* Call duration */}
          {item.type === 'call' && item.duration_seconds && (
            <div className={`text-xs ${metaColor} mt-0.5`}>{fmtDuration(item.duration_seconds)}</div>
          )}

          {/* Meeting notes preview */}
          {item.type === 'note' && item.meeting_notes && !expanded && (
            <div className={`text-sm mt-1 ${isOut ? 'text-indigo-100' : 'text-slate-600'} line-clamp-2`}>
              {item.meeting_notes}
            </div>
          )}

          {/* Audio recording */}
          {item.call_id && (item.recording_path || item.drive_file_id) && (
            <audio controls className="mt-2 w-full h-8"
              src={`/erp/api/calls/${item.call_id}/recording?token=${localStorage.getItem('erp_token')}`} />
          )}

          {/* Expand body */}
          {hasBody && (
            <button onClick={() => setExpanded(e => !e)} className={`mt-1.5 text-xs ${expandColor}`}>
              {expanded ? 'Masquer' : 'Voir le contenu'}
            </button>
          )}
          {expanded && (
            <div className="mt-2 rounded-lg overflow-hidden border border-slate-200/50">
              {item.body_html
                ? <iframe srcDoc={item.body_html} sandbox="allow-same-origin" scrolling="no"
                    className="w-full border-0 bg-white rounded-lg" style={{ minHeight: '200px' }}
                    onLoad={e => { e.target.style.height = e.target.contentDocument.body.scrollHeight + 'px' }} />
                : <div className="p-3 bg-white/90 text-xs text-slate-600 whitespace-pre-wrap rounded-lg">
                    {item.transcript_formatted || item.body_text || item.meeting_notes}
                  </div>
              }
            </div>
          )}
        </div>

        {/* Timestamp below bubble */}
        <div className={`text-[10px] mt-1 px-2 ${metaColor} ${isOut ? 'text-right' : 'text-left'}`}>
          {fmtDate(item.timestamp)}
          {item.user_name && <span> · {item.user_name}</span>}
        </div>
      </div>
    </div>
  )
}

export default function InteractionTimeline({ interactions, loading, total, onLoadMore, loadingMore, showContact = true }) {
  if (loading) {
    return <div className="flex justify-center py-10"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" /></div>
  }
  if (interactions.length === 0) {
    return <div className="card p-10 text-center text-slate-400">Aucune interaction</div>
  }

  // Group by date for separators
  let lastDate = null
  const elements = []
  for (const item of interactions) {
    const day = item.timestamp ? item.timestamp.slice(0, 10) : null
    if (day && day !== lastDate) {
      elements.push(<DateSeparator key={`date-${day}`} date={item.timestamp} />)
      lastDate = day
    }
    elements.push(<Bubble key={item.id} item={item} showContact={showContact} />)
  }

  return (
    <div className="space-y-2 py-2">
      {elements}
      {total != null && interactions.length < total && (
        <button onClick={onLoadMore} disabled={loadingMore} className="btn-secondary w-full mt-3">
          {loadingMore ? 'Chargement...' : `Charger plus (${total - interactions.length} restants)`}
        </button>
      )}
    </div>
  )
}
