import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api.js'
import { usageTone, formatResetIn, formatResetFull } from './ClaudeUsage.jsx'
import { useTravauxQuick } from './TravauxQuickPanel.jsx'

// Jauges IA de la barre de gauche : une mince barre par compte IA qui répond,
// remplie au plus consommé de ses plafonds. Un clic (ou le survol, avec `to`) ouvre le détail, avec la même
// lecture que Travaux : la barre et le chiffre montrent ce qui est CONSOMMÉ.
// Toujours affiché (c'est aussi l'accès à Travaux) : un compte qui ne répond pas
// garde sa dernière lecture connue (navigateur), grisée ; jamais lu → barre vide.
// Données : caches serveur (GET /api/ai-usage).

const POLL_MS = 60_000
const STORE_KEY = 'ai-usage-last'
const KNOWN = [{ key: 'claude', name: 'Claude' }]

// Rail : sigle du titulaire du compte plutôt que « CL » pour chaque licence Claude.
const OWNER_TAGS = { guillaume: 'GL', charles: 'CJ' }
const railTag = (a) => OWNER_TAGS[(a.owner || '').toLowerCase()] || a.name.slice(0, 2)

const readStore =() => { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {} } catch { return {} } }

// Comptes frais + dernières valeurs connues pour ceux qui manquent (`stale`).
// `fresh` null = premier rendu : la dernière lecture s'affiche normalement.
function withLastKnown(fresh) {
  const store = readStore()
  for (const a of fresh || []) store[a.key] = a
  if (fresh) try { localStorage.setItem(STORE_KEY, JSON.stringify(store)) } catch { /* quota */ }
  const byKey = Object.fromEntries((fresh || []).map(a => [a.key, a]))
  const keys = [...KNOWN, ...(fresh || []).filter(a => !KNOWN.some(k => k.key === a.key))]
  return keys.map(k => byKey[k.key]
    || (store[k.key] ? { ...store[k.key], stale: !!fresh } : { ...k, windows: [], stale: true }))
}

const worst = (a) => a.windows.reduce((m, w) => (w.pct > m.pct ? w : m), a.windows[0])

function Bar({ w, className }) {
  const tone = w ? usageTone(w.pct, w.severity) : null
  return (
    <span className={`block rounded-full bg-slate-100 overflow-hidden ${className}`}>
      {w && <span className={`block h-full rounded-full ${tone.bar}`} style={{ width: `${w.pct}%` }} />}
    </span>
  )
}

function Detail({ accounts }) {
  return (
    <div className="divide-y divide-slate-100 text-xs">
      {accounts.map(a => (
        <div key={a.key} className={`py-2.5 first:pt-0 last:pb-0 ${a.stale ? 'opacity-60' : ''}`}>
          <div className="font-semibold text-slate-800 mb-1.5">
            {a.name}{a.owner && <span className="font-normal text-slate-500"> · {a.owner}</span>}{a.stale && <span className="ml-1.5 font-normal text-slate-400">{a.windows.length ? 'hors ligne' : 'indisponible'}</span>}
          </div>
          <div className="grid grid-cols-[auto_5rem_auto_auto] items-center gap-x-2.5 gap-y-1.5">
            {a.windows.map(w => (
              <div key={w.key} className="contents" data-testid={`ai-usage-${a.key}-${w.key}`}>
                <span className="text-slate-500 whitespace-nowrap">{w.label}</span>
                <Bar w={w} className="h-1.5" />
                <span className={`font-semibold tabular-nums whitespace-nowrap ${usageTone(w.pct, w.severity).text}`}>
                  utilisé {w.pct} %
                </span>
                <span className="text-slate-400 tabular-nums whitespace-nowrap"
                  title={w.resetsAt ? `Réinitialisation : ${formatResetFull(w.resetsAt)}` : undefined}>
                  {formatResetIn(w.resetsAt) || ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// `to` (rail seulement) : le détail s'ouvre au survol et le clic mène à `to`.
// `runningBadge` : pastille du nombre de tâches dans la file Travaux (en cours + en attente).
export function AiUsageRail({ wide = false, to, runningBadge = false }) {
  const quick = useTravauxQuick()
  const running = quick?.runningCount || 0
  const inQueue = Math.max(running, quick?.activeCount || 0)
  const [accounts, setAccounts] = useState(() => withLastKnown(null))
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const btnRef = useRef(null)
  const popRef = useRef(null)
  const closeTimer = useRef(null)
  const navigate = useNavigate()
  const hover = !wide && !!to

  useEffect(() => () => clearTimeout(closeTimer.current), [])

  useEffect(() => {
    let alive = true
    const load = () => api.aiUsage()
      .then(r => { if (alive) setAccounts(withLastKnown(r?.accounts || [])) })
      .catch(() => { if (alive) setAccounts(withLastKnown([])) })
    load()
    const t = setInterval(load, POLL_MS)
    return () => { alive = false; clearInterval(t) }
  }, [])

  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      if (!popRef.current?.contains(e.target) && !btnRef.current?.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  const place = () => {
    if (wide || !btnRef.current) return
    const r = btnRef.current.getBoundingClientRect()
    setPos({ left: r.right + 10, bottom: Math.max(8, window.innerHeight - r.bottom) })
  }

  const toggle = () => {
    if (!open) place()
    setOpen(o => !o)
  }

  const show = () => { clearTimeout(closeTimer.current); place(); setOpen(true) }
  const hide = () => { clearTimeout(closeTimer.current); closeTimer.current = setTimeout(() => setOpen(false), 150) }
  const hoverProps = hover ? { onMouseEnter: show, onMouseLeave: hide } : {}

  return (
    <div className={wide ? '' : 'w-full flex justify-center'}>
      <button
        ref={btnRef}
        type="button"
        onClick={hover ? () => { setOpen(false); navigate(to) } : toggle}
        {...hoverProps}
        onFocus={hover ? show : undefined}
        onBlur={hover ? hide : undefined}
        aria-expanded={open}
        aria-label="Quotas IA"
        data-testid="ai-usage"
        className={wide
          ? 'w-full px-2.5 py-1.5 space-y-2 rounded-lg hover:bg-slate-50 text-left'
          : `relative flex flex-col items-center gap-2 w-11 py-1.5 rounded-lg transition-colors ${open ? 'bg-slate-100' : 'hover:bg-slate-100'}`}
      >
        {runningBadge && inQueue > 0 && (
          <span data-testid="ai-usage-running" title={`${running} en cours · ${inQueue - running} en attente`}
            className="absolute -top-1.5 -right-0.5 inline-flex items-center justify-center min-w-[15px] h-[15px] px-1 rounded-full bg-brand-600 text-white text-[9px] font-semibold leading-none">
            {inQueue > 99 ? '99+' : inQueue}
          </span>
        )}
        {accounts.map(a => (
          <span key={a.key} data-testid={`ai-usage-${a.key}`}
            className={`${wide ? 'flex items-center gap-2' : 'flex flex-col items-center gap-[3px]'} ${a.stale ? 'opacity-50' : ''}`}>
            <span className={wide
              ? 'text-[12px] font-medium text-slate-600 min-w-14 whitespace-nowrap'
              : 'flex items-baseline gap-1 text-[9px] font-semibold uppercase tracking-wide text-slate-400'}>
              {wide ? a.name : railTag(a)}
              {/* Rail : ce qui est CONSOMMÉ, toujours visible (même lecture que le détail). */}
              {!wide && worst(a) && (
                <span data-testid={`ai-usage-${a.key}-used`} className={`text-[10px] normal-case tracking-normal tabular-nums ${usageTone(worst(a).pct, worst(a).severity).text}`}>
                  {worst(a).pct}%
                </span>
              )}
            </span>
            <Bar w={worst(a)} className={`h-[3px] ${wide ? 'flex-1' : 'w-8'}`} />
          </span>
        ))}
      </button>

      {open && (wide ? (
        <div className="px-2.5 pt-2 pb-1"><Detail accounts={accounts} /></div>
      ) : (
        <div
          ref={popRef}
          role="dialog"
          data-testid="ai-usage-detail"
          {...hoverProps}
          style={{ position: 'fixed', left: pos?.left, bottom: pos?.bottom }}
          className="z-50 rounded-xl border border-slate-200 bg-white shadow-lg px-3.5 py-3"
        >
          <Detail accounts={accounts} />
        </div>
      ))}
    </div>
  )
}
