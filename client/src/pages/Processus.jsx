import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, Fragment } from 'react'
import { Link } from 'react-router-dom'
import { Zap, ClipboardList, ChevronRight } from 'lucide-react'
import api from '../lib/api.js'
import { useAuth } from '../lib/auth.jsx'
import { hasRole } from '../../../shared/roles.mjs'
import { Layout } from '../components/Layout.jsx'
import { PageTitle } from '../components/PageTitle.jsx'
import { PROCESSES } from '../lib/processMap.js'

// Carte mentale des processus : Orisha au centre, un processus par branche,
// ses étapes = pages de Boréal, et sous chaque étape les automatisations qui y
// agissent (lues en direct ; réservées aux admins comme leur API) et les
// formulaires qu'on y remplit (dont les formulaires HubSpot et pages de
// rendez-vous tenus dans Boréal, lus en direct).
// Définition des branches : lib/processMap.js.

const tint = accent => `rgb(var(--acc-${accent}))`
const soft = (accent, alpha = 0.12) => `rgb(var(--acc-${accent}) / ${alpha})`

const HALF = Math.ceil(PROCESSES.length / 2)
const LEFT = PROCESSES.slice(0, HALF)
const RIGHT = PROCESSES.slice(HALF)

// Ce qu'ouvre l'éclair (automatisations) ou le presse-papiers (formulaires).
function stepItems(step, kind, { autoById, restAutos, live }) {
  if (kind === 'auto') {
    const autos = step.autoRest ? restAutos : (step.auto || []).map(id => autoById[id]).filter(Boolean)
    return autos.map(a => ({ key: a.id, label: a.name, to: `/automations/${a.id}`, off: !a.active }))
  }
  return [
    ...(step.forms || []).map(f => ({ key: f.label, label: f.label })),
    ...(step.live ? live[step.live] || [] : []),
  ]
}

function Branch({ process, ctx, side, headRef }) {
  const [open, setOpen] = useState(null) // { to, kind }
  const Icon = process.icon
  const steps = process.steps.filter(s => !s.adminOnly || ctx.isAdmin)
  const opened = open && steps.find(s => s.to === open.to)
  const items = opened ? stepItems(opened, open.kind, ctx) : []
  const toggle = (to, kind) => setOpen(o => (o?.to === to && o.kind === kind ? null : { to, kind }))
  const counter = (step, kind, n, KindIcon, title) => n > 0 && (
    <button
      type="button"
      onClick={() => toggle(step.to, kind)}
      className="inline-flex items-center gap-0.5 pr-1.5 pl-1 py-1 border-l"
      style={{ borderColor: soft(process.accent), color: tint(process.accent) }}
      aria-expanded={open?.to === step.to && open.kind === kind}
      title={title}
    >
      <KindIcon size={11} /> {n}
    </button>
  )
  return (
    <div className={`w-full max-w-md flex flex-col ${side === 'left' ? 'items-end' : 'items-start'}`}>
      <div
        ref={headRef}
        className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-white text-sm font-semibold shadow-sm"
        style={{ background: tint(process.accent) }}
      >
        <Icon size={15} /> {process.label}
      </div>
      <div className={`mt-2 flex flex-wrap items-center gap-1 ${side === 'left' ? 'justify-end' : ''}`}>
        {steps.map((step, i) => {
          const nAuto = stepItems(step, 'auto', ctx).length
          const nForm = stepItems(step, 'form', ctx).length
          return (
            <Fragment key={step.to}>
              {i > 0 && <ChevronRight size={13} className="text-slate-300 flex-shrink-0" aria-hidden="true" />}
              <span
                className="inline-flex items-center rounded-lg border text-xs bg-white"
                style={{ borderColor: open?.to === step.to ? tint(process.accent) : soft(process.accent) }}
              >
                <Link to={step.to} className="px-2 py-1 text-slate-700 hover:underline">{step.label}</Link>
                {counter(step, 'auto', nAuto, Zap, 'Automatisations')}
                {counter(step, 'form', nForm, ClipboardList, 'Formulaires')}
              </span>
            </Fragment>
          )
        })}
      </div>
      {items.length > 0 && (
        <ul
          className={`mt-2 w-full rounded-lg px-3 py-2 space-y-1 text-xs ${side === 'left' ? 'text-right' : ''}`}
          style={{ background: soft(process.accent) }}
        >
          {items.map(it => (
            <li key={it.key} className={it.off ? 'opacity-50 line-through' : ''}>
              {it.to
                ? <Link to={it.to} className="text-slate-700 hover:underline">{it.label}</Link>
                : <span className="text-slate-700">{it.label}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default function Processus() {
  const { user } = useAuth()
  const isAdmin = hasRole(user, 'admin')
  const [autoById, setAutoById] = useState({})
  const [live, setLive] = useState({})
  const [paths, setPaths] = useState([])
  const wrapRef = useRef(null)
  const centerRef = useRef(null)
  const headRefs = useRef({})

  useEffect(() => {
    if (!isAdmin) return
    let alive = true
    api.automations.list()
      .then(list => { if (alive) setAutoById(Object.fromEntries((list || []).map(a => [a.id, a]))) })
      .catch(() => {})
    return () => { alive = false }
  }, [isAdmin])

  useEffect(() => {
    let alive = true
    Promise.all([
      api.marketingForms.list().then(r => (r?.data || []).map(f => ({
        key: f.id, label: f.name, to: `/formulaires/${f.id}`,
      }))).catch(() => []),
      api.meetings.types().then(r => (r || []).map(t => ({
        key: t.id, label: t.name, to: `/rendez-vous/${t.id}`,
      }))).catch(() => []),
    ]).then(([marketingForms, meetingTypes]) => { if (alive) setLive({ marketingForms, meetingTypes }) })
    return () => { alive = false }
  }, [])

  // Automatisations qu'aucune étape ne cite : rangées sous Système → Automatisations.
  const restAutos = useMemo(() => {
    const cited = new Set(PROCESSES.flatMap(p => p.steps.flatMap(s => s.auto || [])))
    return Object.values(autoById).filter(a => !cited.has(a.id)).sort((a, b) => a.name.localeCompare(b.name))
  }, [autoById])
  const ctx = { isAdmin, autoById, restAutos, live }

  // Liens courbes centre → tête de branche, recalculés à chaque changement de
  // taille (ouverture d'une liste d'automatisations, fenêtre redimensionnée).
  const measure = useCallback(() => {
    const wrap = wrapRef.current, center = centerRef.current
    if (!wrap || !center || !center.offsetParent) { setPaths([]); return }
    const w = wrap.getBoundingClientRect()
    const c = center.getBoundingClientRect()
    const next = PROCESSES.map(p => {
      const el = headRefs.current[p.key]
      if (!el) return null
      const h = el.getBoundingClientRect()
      const isLeft = LEFT.includes(p)
      const x1 = (isLeft ? c.left : c.right) - w.left
      const y1 = c.top + c.height / 2 - w.top
      const x2 = (isLeft ? h.right : h.left) - w.left
      const y2 = h.top + h.height / 2 - w.top
      const mx = (x1 + x2) / 2
      return { key: p.key, accent: p.accent, d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}` }
    }).filter(Boolean)
    setPaths(next)
  }, [])

  useLayoutEffect(() => {
    measure()
    const ro = new ResizeObserver(measure)
    // Les colonnes aussi : l'une peut grandir sans changer la hauteur du tout.
    if (wrapRef.current) [wrapRef.current, ...wrapRef.current.children].forEach(el => ro.observe(el))
    return () => ro.disconnect()
  }, [measure])

  const branch = side => p => (
    <Branch
      key={p.key}
      process={p}
      side={side}
      ctx={ctx}
      headRef={el => { headRefs.current[p.key] = el }}
    />
  )

  return (
    <Layout>
      <div className="p-6">
        <PageTitle className="mb-6">Processus</PageTitle>
        <div
          ref={wrapRef}
          className="relative grid grid-cols-1 lg:grid-cols-[1fr_auto_1fr] gap-y-8 gap-x-20 items-center"
          data-testid="process-map"
        >
          <svg className="hidden lg:block absolute inset-0 w-full h-full pointer-events-none" aria-hidden="true">
            {paths.map(p => (
              <path key={p.key} d={p.d} fill="none" strokeWidth="2" style={{ stroke: soft(p.accent, 0.55) }} />
            ))}
          </svg>
          <div className="flex flex-col gap-8 lg:items-end">{LEFT.map(branch('left'))}</div>
          <div
            ref={centerRef}
            className="hidden lg:flex relative z-10 w-28 h-28 rounded-full items-center justify-center text-white font-bold shadow-md"
            style={{ background: tint('brand') }}
          >
            Orisha
          </div>
          <div className="flex flex-col gap-8 items-start">{RIGHT.map(branch('right'))}</div>
        </div>
      </div>
    </Layout>
  )
}
