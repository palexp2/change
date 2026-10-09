import { useEffect, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import api from '../lib/api.js'
import { fmtDateTime } from '../lib/formatDate.js'

// Ouvertures, clics et réponses d'un courriel envoyé, à la HubSpot : une ligne
// de compteurs, dépliable en chronologie (Répondu / Cliqué / Ouvert / Envoyé).
// Ouvertures et clics viennent du pixel + liens suivis (services/emailTracking.js)
// — seulement pour un courriel parti de Boréal ; les réponses, du fil Gmail.
// `item` (ligne du fil) donne les compteurs sans requête ; sans lui, on charge.
const SHOWN = 8

function events(data) {
  const list = [
    ...data.replies.map(at => ({ at, label: 'Répondu' })),
    ...data.links.flatMap(l => l.clicks.map(at => ({ at, label: 'Cliqué', url: l.url, link: l.label || l.url }))),
    ...data.opens.map(at => ({ at, label: 'Ouvert' })),
  ].sort((a, b) => String(b.at).localeCompare(String(a.at)))
  if (data.sent_at) list.push({ at: data.sent_at, label: 'Envoyé' })
  return list
}

function Timeline({ data }) {
  const [all, setAll] = useState(false)
  const list = events(data)
  const shown = all ? list : list.slice(0, SHOWN)
  return (
    <ol className="mt-2 ml-1.5">
      {shown.map((ev, i) => (
        <li key={i} className="relative flex gap-2.5 pb-3 last:pb-0">
          {i < shown.length - 1 && <span className="absolute left-[7px] top-4 bottom-0 w-0.5 bg-green-700" aria-hidden />}
          <span className="relative z-10 mt-0.5 h-4 w-4 flex-shrink-0 rounded-full border-2 border-green-700 bg-white" />
          <div className="min-w-0 leading-tight">
            <div className="text-xs font-semibold text-slate-700">{ev.label}</div>
            {ev.url && (
              <a href={ev.url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}
                className="block text-[11px] link-record truncate" title={ev.url}>{ev.link}</a>
            )}
            <div className="text-[11px] text-slate-500 tabular-nums">{fmtDateTime(ev.at)}</div>
          </div>
        </li>
      ))}
      {list.length > SHOWN && (
        <li className="pl-6">
          <button type="button" onClick={e => { e.stopPropagation(); setAll(v => !v) }} className="text-[11px] link-record">
            {all ? '−' : `+${list.length - SHOWN}`}
          </button>
        </li>
      )}
    </ol>
  )
}

export default function EmailTrackingBlock({ interactionId, item, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen)
  const [data, setData] = useState(null)
  const needData = open || !item
  useEffect(() => {
    if (!needData || data) return
    let alive = true
    api.interactions.tracking(interactionId).then(d => { if (alive) setData(d) }).catch(() => {})
    return () => { alive = false }
  }, [interactionId, needData, data])

  const counts = data
    ? {
        tracked: data.tracked,
        opens: data.opens.length,
        clicks: data.links.reduce((n, l) => n + l.clicks.length, 0),
        replies: data.replies?.length || 0,
      }
    : item && {
        tracked: !!item.email_tracked,
        opens: item.open_count || 0,
        clicks: item.click_count || 0,
        replies: item.reply_count || 0,
      }
  // Sans suivi ni réponse, il n'y a rien à dire.
  if (!counts || (!counts.tracked && !counts.replies)) return null
  const active = counts.opens || counts.clicks || counts.replies

  return (
    <div data-testid="email-tracking" className="text-xs text-slate-600" onClick={e => e.stopPropagation()}>
      <button type="button" onClick={() => setOpen(v => !v)} className="inline-flex items-center gap-1.5 rounded hover:text-slate-900">
        <ChevronRight size={14} className={`text-slate-400 transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className={`h-2 w-2 rounded-full ${active ? 'bg-green-600' : 'bg-slate-300'}`} aria-hidden />
        {counts.tracked && <span className="tabular-nums">Ouvertures : {counts.opens}</span>}
        {counts.tracked && <span className="tabular-nums ml-2">Clics : {counts.clicks}</span>}
        <span className={`tabular-nums ${counts.tracked ? 'ml-2' : ''}`}>Réponses : {counts.replies}</span>
      </button>
      {open && data && <Timeline data={{ ...data, replies: data.replies || [] }} />}
    </div>
  )
}
