import { useEffect, useState } from 'react'
import { Eye, MousePointerClick } from 'lucide-react'
import api from '../lib/api.js'
import { fmtDateTime } from '../lib/formatDate.js'

// Ouvertures et clics d'un courriel envoyé depuis Boréal (pixel + liens
// suivis, services/emailTracking.js). Rien pour un courriel sans suivi.
const SHOWN = 5

function Times({ list }) {
  const [all, setAll] = useState(false)
  if (!list.length) return null
  const shown = all ? list : list.slice(0, SHOWN)
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {shown.map((t, i) => (
        <span key={i} className="rounded bg-slate-100 px-1.5 py-px text-[11px] text-slate-600 tabular-nums">{fmtDateTime(t)}</span>
      ))}
      {list.length > SHOWN && (
        <button type="button" onClick={() => setAll(v => !v)} className="text-[11px] link-record">
          {all ? '−' : `+${list.length - SHOWN}`}
        </button>
      )}
    </div>
  )
}

export default function EmailTrackingBlock({ interactionId }) {
  const [data, setData] = useState(null)
  useEffect(() => {
    let alive = true
    api.interactions.tracking(interactionId).then(d => { if (alive) setData(d) }).catch(() => {})
    return () => { alive = false }
  }, [interactionId])

  if (!data?.tracked) return null
  return (
    <div data-testid="email-tracking">
      <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-1.5">Suivi</div>
      <div className="space-y-2.5 text-sm">
        <div>
          <span className="inline-flex items-center gap-1.5 text-slate-700" title="Ouvertures">
            <Eye size={14} className={data.opens.length ? 'text-green-600' : 'text-slate-400'} />
            <span className="tabular-nums font-medium">{data.opens.length}</span>
          </span>
          <Times list={data.opens} />
        </div>
        {data.links.map(l => (
          <div key={l.url} className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <span className="inline-flex items-center gap-1 text-slate-700 flex-shrink-0" title="Clics">
                <MousePointerClick size={14} className={l.clicks.length ? 'text-brand-600' : 'text-slate-400'} />
                <span className="tabular-nums font-medium">{l.clicks.length}</span>
              </span>
              <a href={l.url} target="_blank" rel="noreferrer" className="link-record truncate" title={l.url}>
                {l.label || l.url}
              </a>
            </div>
            <Times list={l.clicks} />
          </div>
        ))}
      </div>
    </div>
  )
}
