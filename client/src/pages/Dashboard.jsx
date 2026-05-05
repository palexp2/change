import { useState, useEffect, Fragment } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowRight, SlidersHorizontal, X, Check, Target, Trophy } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { useAuth } from '../lib/auth.jsx'
import { GeoClientsMap } from '../components/GeoClientsMap.jsx'
import { fmtDate } from '../lib/formatDate.js'
import { Modal } from '../components/Modal.jsx'

const WIDGET_DEFS = [
  { id: 'section_project_goal',     label: 'Objectif de projets',      group: 'Objectifs' },
  { id: 'section_stripe_revenue',   label: 'Ventes et abonnements',    group: 'Graphiques' },
  { id: 'section_subscription_events', label: 'Mouvements d\'abonnements', group: 'Graphiques' },
  { id: 'section_profitability',    label: 'Rentabilité',              group: 'Graphiques' },
  { id: 'section_replacement_rate', label: 'Taux de remplacement',     group: 'Graphiques' },
  { id: 'section_projects_created', label: 'Projets créés par mois',   group: 'Graphiques' },
  { id: 'section_closing',       label: 'Taux de closing',       group: 'Graphiques' },
  { id: 'section_shipments',     label: 'Livraisons par semaine', group: 'Graphiques' },
  { id: 'section_shipping_costs', label: 'Coûts d\'expédition',    group: 'Graphiques' },
  { id: 'section_geo_map',       label: 'Carte des clients',     group: 'Graphiques' },
  { id: 'section_top_products', label: 'Meilleurs vendeurs',     group: 'Graphiques' },
  { id: 'section_inventory_valuation', label: 'Valeur de l\'inventaire', group: 'Inventaire' },
  { id: 'section_support_weekly', label: 'Amélioration du support', group: 'Support' },
]

const DEFAULT_PREFS = Object.fromEntries(WIDGET_DEFS.map(w => [w.id, true]))

function loadPrefs(userId) {
  try {
    const raw = localStorage.getItem(`dashboard_prefs_${userId}`)
    if (raw) return { ...DEFAULT_PREFS, ...JSON.parse(raw) }
  } catch {}
  return { ...DEFAULT_PREFS }
}

function savePrefs(userId, prefs) {
  localStorage.setItem(`dashboard_prefs_${userId}`, JSON.stringify(prefs))
}

function DashboardEditor({ prefs, onChange, onClose }) {
  const groups = [...new Set(WIDGET_DEFS.map(w => w.group))]
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-end p-4 pt-16 pointer-events-none">
      <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-72 pointer-events-auto">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
          <h3 className="font-semibold text-slate-900 text-sm">Personnaliser le dashboard</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 p-1 rounded"><X size={14} /></button>
        </div>
        <div className="p-4 space-y-4 max-h-[70vh] overflow-y-auto">
          {groups.map(group => (
            <div key={group}>
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">{group}</p>
              <div className="space-y-1">
                {WIDGET_DEFS.filter(w => w.group === group).map(w => (
                  <label key={w.id} className="flex items-center gap-2.5 px-2 py-1.5 rounded hover:bg-slate-50 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={prefs[w.id] !== false}
                      onChange={e => onChange({ ...prefs, [w.id]: e.target.checked })}
                      className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                    />
                    <span className="text-sm text-slate-700">{w.label}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="px-4 py-3 border-t border-slate-100">
          <button onClick={onClose} className="w-full btn-primary btn-sm text-xs">
            <Check size={12} /> Fermer
          </button>
        </div>
      </div>
    </div>
  )
}

function ProjectGoalWidget({ goal, onEdit }) {
  const { target, current, end_date } = goal || {}
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'

  if (!target) {
    return (
      <div className="flex flex-col items-center justify-center h-32 border-2 border-dashed border-slate-200 rounded-xl text-slate-400">
        <Target size={24} className="mb-2 opacity-50" />
        <p className="text-sm">Aucun objectif configuré</p>
        {isAdmin && (
          <button onClick={onEdit} className="mt-2 text-brand-600 text-sm font-medium hover:underline">
            Configurer un objectif
          </button>
        )}
      </div>
    )
  }

  const progress = Math.min(Math.round((current / target) * 100), 100)
  const daysLeft = end_date ? Math.max(0, Math.ceil((new Date(end_date + 'T23:59:59') - new Date()) / (1000 * 60 * 60 * 24))) : null

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-bold text-slate-900">{current}</span>
          <span className="text-slate-400">/ {target} projets</span>
        </div>
        {isAdmin && (
          <button onClick={onEdit} className="text-slate-400 hover:text-brand-600 p-1 rounded-lg hover:bg-slate-50 transition-colors">
            <SlidersHorizontal size={14} />
          </button>
        )}
      </div>
      
      <div className="h-4 bg-slate-100 rounded-full overflow-hidden mb-2">
        <div 
          className="h-full bg-brand-500 transition-all duration-500 ease-out"
          style={{ width: `${progress}%` }}
        />
      </div>

      <div className="flex justify-between text-xs font-medium">
        <span className={progress >= 100 ? 'text-green-600' : 'text-slate-500'}>
          {progress}% complété
        </span>
        {daysLeft !== null && (
          <span className="text-slate-500">
            {daysLeft === 0 ? "Échéance aujourd'hui" : `${daysLeft} jour${daysLeft > 1 ? 's' : ''} restant${daysLeft > 1 ? 's' : ''}`}
          </span>
        )}
      </div>
    </div>
  )
}

function GoalEditorModal({ isOpen, onClose, onSave }) {
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState({ target_qty: '', start_date: '', end_date: '' })

  useEffect(() => {
    if (isOpen) {
      setLoading(true)
      api.dashboard.getGoal()
        .then(setForm)
        .catch(console.error)
        .finally(() => setLoading(false))
    }
  }, [isOpen])

  async function handleSubmit(e) {
    e.preventDefault()
    setLoading(true)
    try {
      await api.dashboard.updateGoal(form)
      onSave()
      onClose()
    } catch (err) {
      alert(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Configurer l'objectif de projets" size="sm">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Quantité cible</label>
          <input
            type="number"
            required
            min="1"
            className="w-full rounded-lg border-slate-200 focus:border-brand-500 focus:ring-brand-500"
            value={form.target_qty}
            onChange={e => setForm({ ...form, target_qty: e.target.value })}
            placeholder="ex: 50"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Date de début</label>
            <input
              type="date"
              required
              className="w-full rounded-lg border-slate-200 focus:border-brand-500 focus:ring-brand-500"
              value={form.start_date}
              onChange={e => setForm({ ...form, start_date: e.target.value })}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Date de fin</label>
            <input
              type="date"
              required
              className="w-full rounded-lg border-slate-200 focus:border-brand-500 focus:ring-brand-500"
              value={form.end_date}
              onChange={e => setForm({ ...form, end_date: e.target.value })}
            />
          </div>
        </div>
        <div className="pt-2">
          {/* Manual save instead of autosave to avoid triggering expensive dashboard refreshes on every keystroke */}
          <button type="submit" disabled={loading} className="w-full btn-primary py-2.5">
            {loading ? 'Enregistrement...' : 'Enregistrer'}
          </button>
        </div>
      </form>
    </Modal>
  )
}



// SVG path helper — rectangle with independent corner radii, used to draw
// stacked bars where the junction between the two segments stays sharp while
// the outer top + bottom of the combined bar remain rounded.
function roundedRectPath(x, y, w, h, rTL, rTR, rBR, rBL) {
  const tl = Math.min(rTL, w / 2, h / 2)
  const tr = Math.min(rTR, w / 2, h / 2)
  const br = Math.min(rBR, w / 2, h / 2)
  const bl = Math.min(rBL, w / 2, h / 2)
  return `M${x + tl},${y}
          L${x + w - tr},${y} Q${x + w},${y} ${x + w},${y + tr}
          L${x + w},${y + h - br} Q${x + w},${y + h} ${x + w - br},${y + h}
          L${x + bl},${y + h} Q${x},${y + h} ${x},${y + h - bl}
          L${x},${y + tl} Q${x},${y} ${x + tl},${y} Z`
}

// Stripe revenue chart — last 12 months bucketed on document_date, split into
// service (subscription) and achat (one-shot order). Each month is paired with
// the matching month of the previous year, also stacked service+achat but
// rendered in two grays (pâle = service, foncé = achat) so the comparison bar
// carries the same breakdown as the current year.
// Backend converts USD → CAD at the document_date BoC rate, taxes excluded.
function StripeRevenueChart({ data, onMonthClick }) {
  const [tooltip, setTooltip] = useState(null)

  const byMonth = {}
  for (const r of data || []) byMonth[r.month] = r

  const now = new Date()
  const months = []
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    const prev = new Date(d.getFullYear() - 1, d.getMonth(), 1)
    const prevKey = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`
    const curr = byMonth[key] || { service: 0, achat: 0 }
    const prevRow = byMonth[prevKey] || { service: 0, achat: 0 }
    months.push({
      key, prevKey,
      label: d.toLocaleDateString('fr-CA', { month: 'short' }),
      year: d.getFullYear(),
      service: curr.service || 0,
      achat: curr.achat || 0,
      total: (curr.service || 0) + (curr.achat || 0),
      prevService: prevRow.service || 0,
      prevAchat: prevRow.achat || 0,
      prevTotal: (prevRow.service || 0) + (prevRow.achat || 0),
    })
  }

  const totalCurr = months.reduce((s, m) => s + m.total, 0)
  const totalService = months.reduce((s, m) => s + m.service, 0)
  const totalAchat = months.reduce((s, m) => s + m.achat, 0)
  const maxVal = Math.max(...months.flatMap(m => [m.total, m.prevTotal]), 1)

  const W = 600, H = 200
  const padL = 44, padR = 8, padT = 12, padB = 32
  const chartW = W - padL - padR
  const chartH = H - padT - padB
  const n = months.length
  const groupW = chartW / n
  const barW = Math.max(Math.floor((groupW - 6) / 2), 6)

  const yPos = v => padT + chartH - (v / maxVal) * chartH
  const groupCenter = i => padL + (i + 0.5) * groupW

  const niceStep = (() => {
    if (maxVal <= 1000) return 200
    if (maxVal <= 5000) return 1000
    if (maxVal <= 20000) return 5000
    if (maxVal <= 50000) return 10000
    if (maxVal <= 100000) return 20000
    return Math.ceil(maxVal / 5 / 10000) * 10000
  })()
  const gridVals = []
  for (let v = 0; v <= maxVal; v += niceStep) gridVals.push(v)
  if (gridVals[gridVals.length - 1] < maxVal) gridVals.push(maxVal)

  const fmtAxis = v => {
    if (v >= 1000) return `${Math.round(v / 1000)}k$`
    return `${Math.round(v)}$`
  }
  const fmtMoney = v => new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 }).format(v)

  const hasAny = totalCurr > 0
  if (!hasAny) {
    return (
      <div className="flex items-center justify-center h-40 text-slate-300 text-sm">
        Aucune vente ni abonnement Stripe sur les 12 derniers mois
      </div>
    )
  }

  return (
    <div className="relative w-full">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-3">
        <div className="flex gap-4 text-xs text-slate-500 flex-wrap">
          <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-sm bg-brand-500" /> Abonnement <span className="font-semibold text-slate-700 ml-1">{fmtMoney(totalService)}</span></span>
          <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-sm bg-amber-500" /> Vente <span className="font-semibold text-slate-700 ml-1">{fmtMoney(totalAchat)}</span></span>
          <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-sm bg-slate-200" /> Abonnement an. préc.</span>
          <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-sm bg-slate-400" /> Vente an. préc.</span>
        </div>
        <span className="text-sm font-semibold text-slate-700">
          Total <span className="text-slate-900">{fmtMoney(totalCurr)}</span>
          <span className="text-xs font-normal text-slate-400 ml-1">12 derniers mois</span>
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 220 }}>
        {gridVals.map((v, gi) => (
          <g key={gi}>
            <line x1={padL} x2={W - padR} y1={yPos(v)} y2={yPos(v)} stroke={v === 0 ? '#cbd5e1' : '#f1f5f9'} strokeWidth={v === 0 ? 0.8 : 1} />
            <text x={padL - 4} y={yPos(v) + 3.5} textAnchor="end" fontSize="9" fill="#94a3b8">{fmtAxis(v)}</text>
          </g>
        ))}
        {months.map((m, i) => {
          const cx = groupCenter(i)
          const xCurr = cx - barW - 1
          const xPrev = cx + 1
          const hService = (m.service / maxVal) * chartH
          const hAchat = (m.achat / maxVal) * chartH
          const hPrevService = (m.prevService / maxVal) * chartH
          const hPrevAchat = (m.prevAchat / maxVal) * chartH
          const isHovered = tooltip?.i === i
          const yServiceTop = padT + chartH - hService - hAchat
          const yAchatTop = padT + chartH - hAchat
          const yPrevServiceTop = padT + chartH - hPrevService - hPrevAchat
          const yPrevAchatTop = padT + chartH - hPrevAchat
          return (
            <g key={m.key}
              data-testid={`stripe-revenue-month-${m.key}`}
              onMouseEnter={() => setTooltip({ i, x: cx, m })}
              onMouseLeave={() => setTooltip(null)}
            >
              <rect x={padL + i * groupW} y={0} width={groupW} height={H} fill="transparent" />
              {/* Previous-year — stacked : service (gris pâle) en haut, achat (gris foncé)
                  en bas (sur la ligne de base). Outer corners rounded ; jonction carrée. */}
              {m.prevService > 0 && (
                <path d={roundedRectPath(xPrev, yPrevAchatTop - hPrevService, barW, hPrevService,
                  2, 2, m.prevAchat > 0 ? 0 : 2, m.prevAchat > 0 ? 0 : 2)}
                  fill={isHovered ? '#cbd5e1' : '#e2e8f0'}
                />
              )}
              {m.prevAchat > 0 && (
                <path d={roundedRectPath(xPrev, yPrevAchatTop, barW, hPrevAchat,
                  m.prevService > 0 ? 0 : 2, m.prevService > 0 ? 0 : 2, 2, 2)}
                  fill={isHovered ? '#64748b' : '#94a3b8'}
                />
              )}
              {/* Current month — stacked : service en haut, achat en bas (sur la ligne
                  de base). Outer corners rounded ; jonction service↔achat carrée. */}
              {m.service > 0 && (
                <path d={roundedRectPath(xCurr, yAchatTop - hService, barW, hService,
                  2, 2, m.achat > 0 ? 0 : 2, m.achat > 0 ? 0 : 2)}
                  fill={isHovered ? '#1B8E3C' : '#21B14B'}
                  style={{ cursor: onMonthClick ? 'pointer' : 'default' }}
                  onClick={() => onMonthClick && onMonthClick(m.key, 'service')}
                />
              )}
              {m.achat > 0 && (
                <path d={roundedRectPath(xCurr, yAchatTop, barW, hAchat,
                  m.service > 0 ? 0 : 2, m.service > 0 ? 0 : 2, 2, 2)}
                  fill={isHovered ? '#d97706' : '#f59e0b'}
                  style={{ cursor: onMonthClick ? 'pointer' : 'default' }}
                  onClick={() => onMonthClick && onMonthClick(m.key, 'achat')}
                />
              )}
              <text x={cx} y={H - 18} textAnchor="middle" fontSize="9" fill={i === n - 1 ? '#0f172a' : '#94a3b8'} fontWeight={i === n - 1 ? '600' : 'normal'}>{m.label}</text>
              <text x={cx} y={H - 6} textAnchor="middle" fontSize="8" fill="#cbd5e1">{m.year}</text>
            </g>
          )
        })}
        {tooltip && (() => {
          const m = tooltip.m
          const tx = Math.min(Math.max(tooltip.x, 95), W - 95)
          const ty = padT + 8
          const delta = m.prevTotal > 0 ? Math.round(((m.total - m.prevTotal) / m.prevTotal) * 100) : null
          return (
            <g pointerEvents="none">
              <rect x={tx - 90} y={ty - 4} width={180} height={104} rx="5" fill="#1e293b" opacity="0.93" />
              <text x={tx} y={ty + 9} textAnchor="middle" fontSize="10" fill="#cbd5e1">{m.label} {m.year}</text>
              <text x={tx - 80} y={ty + 25} textAnchor="start" fontSize="10" fill="#21B14B">Abonnement</text>
              <text x={tx + 80} y={ty + 25} textAnchor="end" fontSize="11" fontWeight="bold" fill="white">{fmtMoney(m.service)}</text>
              <text x={tx - 80} y={ty + 40} textAnchor="start" fontSize="10" fill="#f59e0b">Vente</text>
              <text x={tx + 80} y={ty + 40} textAnchor="end" fontSize="11" fontWeight="bold" fill="white">{fmtMoney(m.achat)}</text>
              <text x={tx - 80} y={ty + 58} textAnchor="start" fontSize="10" fill="#cbd5e1">Abonnement an. préc.</text>
              <text x={tx + 80} y={ty + 58} textAnchor="end" fontSize="11" fontWeight="bold" fill="#cbd5e1">{fmtMoney(m.prevService)}</text>
              <text x={tx - 80} y={ty + 73} textAnchor="start" fontSize="10" fill="#94a3b8">Vente an. préc.</text>
              <text x={tx + 80} y={ty + 73} textAnchor="end" fontSize="11" fontWeight="bold" fill="#cbd5e1">{fmtMoney(m.prevAchat)}</text>
              {delta !== null && (
                <text x={tx} y={ty + 90} textAnchor="middle" fontSize="9" fill={delta >= 0 ? '#4ade80' : '#f87171'}>
                  {delta >= 0 ? '+' : ''}{delta}% vs an. préc.
                </text>
              )}
            </g>
          )
        })()}
      </svg>
      {onMonthClick && <p className="text-xs text-slate-400 text-right mt-1">Cliquer sur une portion pour voir les factures correspondantes</p>}
    </div>
  )
}

function ProjectsCreatedChart({ data, onMonthClick }) {
  const [tooltip, setTooltip] = useState(null)

  const now = new Date()
  const currYear = now.getFullYear()
  const prevYear = currYear - 1
  const currentMonthIdx = now.getMonth() // 0-based

  const counts = {}
  for (const r of data || []) counts[r.month] = r.count

  const months = []
  for (let m = 0; m < 12; m++) {
    const key = String(m + 1).padStart(2, '0')
    const currKey = `${currYear}-${key}`
    const prevKey = `${prevYear}-${key}`
    months.push({
      idx: m,
      label: new Date(2000, m, 1).toLocaleDateString('fr-CA', { month: 'short' }),
      curr: counts[currKey] || 0,
      prev: counts[prevKey] || 0,
      currKey,
      prevKey,
      isFuture: m > currentMonthIdx,
    })
  }

  const totalCurr = months.reduce((s, m) => s + m.curr, 0)
  const totalPrevYTD = months.reduce((s, m) => m.idx <= currentMonthIdx ? s + m.prev : s, 0)
  const totalPrev = months.reduce((s, m) => s + m.prev, 0)
  const deltaPct = totalPrevYTD > 0 ? Math.round(((totalCurr - totalPrevYTD) / totalPrevYTD) * 100) : null

  const maxVal = Math.max(...months.flatMap(m => [m.curr, m.prev]), 1)

  const W = 600, H = 180
  const padL = 32, padR = 8, padT = 12, padB = 28
  const chartW = W - padL - padR
  const chartH = H - padT - padB
  const n = months.length
  const groupW = chartW / n
  const barW = Math.max(Math.floor((groupW - 6) / 2), 6)

  const yPos = v => padT + chartH - (v / maxVal) * chartH
  const groupCenter = i => padL + (i + 0.5) * groupW

  const niceStep = (() => {
    if (maxVal <= 4) return 1
    if (maxVal <= 10) return 2
    if (maxVal <= 25) return 5
    return Math.ceil(maxVal / 5)
  })()
  const gridVals = []
  for (let v = 0; v <= maxVal; v += niceStep) gridVals.push(v)
  if (gridVals[gridVals.length - 1] < maxVal) gridVals.push(maxVal)

  const hasAny = totalCurr + totalPrev > 0
  if (!hasAny) {
    return (
      <div className="flex items-center justify-center h-40 text-slate-300 text-sm">
        Pas encore de projets créés
      </div>
    )
  }

  return (
    <div className="relative w-full">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-3">
        <div className="flex gap-4 text-xs text-slate-500">
          <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-sm bg-brand-500" /> {currYear} <span className="font-semibold text-slate-700 ml-1">{totalCurr}</span></span>
          <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-sm bg-slate-300" /> {prevYear} <span className="font-semibold text-slate-700 ml-1">{totalPrev}</span></span>
        </div>
        {deltaPct !== null && (
          <span className={`text-sm font-semibold ${deltaPct >= 0 ? 'text-green-600' : 'text-red-500'}`}>
            {deltaPct >= 0 ? '+' : ''}{deltaPct}%
            <span className="text-xs font-normal text-slate-400 ml-1">vs {prevYear} YTD ({totalPrevYTD})</span>
          </span>
        )}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 200 }}>
        {gridVals.map((v, gi) => (
          <g key={gi}>
            <line x1={padL} x2={W - padR} y1={yPos(v)} y2={yPos(v)} stroke={v === 0 ? '#cbd5e1' : '#f1f5f9'} strokeWidth={v === 0 ? 0.8 : 1} />
            <text x={padL - 4} y={yPos(v) + 3.5} textAnchor="end" fontSize="9" fill="#94a3b8">{v}</text>
          </g>
        ))}
        {months.map((m, i) => {
          const cx = groupCenter(i)
          const xPrev = cx - barW - 1
          const xCurr = cx + 1
          const hPrev = (m.prev / maxVal) * chartH
          const hCurr = (m.curr / maxVal) * chartH
          const isHovered = tooltip?.i === i
          return (
            <g key={m.idx}
              data-testid={`projects-created-month-${m.idx}`}
              onMouseEnter={() => setTooltip({ i, x: cx, m })}
              onMouseLeave={() => setTooltip(null)}
            >
              <rect x={padL + i * groupW} y={0} width={groupW} height={H} fill="transparent" />
              {m.prev > 0 && (
                <rect x={xPrev} y={padT + chartH - hPrev} width={barW} height={hPrev} rx="2"
                  fill={isHovered ? '#94a3b8' : '#cbd5e1'}
                  style={{ cursor: onMonthClick ? 'pointer' : 'default' }}
                  onClick={() => onMonthClick && onMonthClick(m.prevKey)}
                />
              )}
              {m.curr > 0 && !m.isFuture && (
                <rect x={xCurr} y={padT + chartH - hCurr} width={barW} height={hCurr} rx="2"
                  fill={isHovered ? '#1B8E3C' : '#21B14B'}
                  style={{ cursor: onMonthClick ? 'pointer' : 'default' }}
                  onClick={() => onMonthClick && onMonthClick(m.currKey)}
                />
              )}
              <text x={cx} y={H - 4} textAnchor="middle" fontSize="9" fill={m.idx === currentMonthIdx ? '#0f172a' : '#94a3b8'} fontWeight={m.idx === currentMonthIdx ? '600' : 'normal'}>{m.label}</text>
            </g>
          )
        })}
        {tooltip && (() => {
          const m = tooltip.m
          const tx = Math.min(Math.max(tooltip.x, 80), W - 80)
          const ty = padT + 8
          const delta = m.prev > 0 ? Math.round(((m.curr - m.prev) / m.prev) * 100) : null
          return (
            <g pointerEvents="none">
              <rect x={tx - 70} y={ty - 4} width={140} height={64} rx="5" fill="#1e293b" opacity="0.93" />
              <text x={tx} y={ty + 9} textAnchor="middle" fontSize="10" fill="#cbd5e1">{m.label}</text>
              <text x={tx - 60} y={ty + 25} textAnchor="start" fontSize="10" fill="#21B14B">{currYear}</text>
              <text x={tx + 60} y={ty + 25} textAnchor="end" fontSize="11" fontWeight="bold" fill="white">{m.curr}{m.isFuture ? ' (—)' : ''}</text>
              <text x={tx - 60} y={ty + 40} textAnchor="start" fontSize="10" fill="#94a3b8">{prevYear}</text>
              <text x={tx + 60} y={ty + 40} textAnchor="end" fontSize="11" fontWeight="bold" fill="#cbd5e1">{m.prev}</text>
              {delta !== null && !m.isFuture && (
                <text x={tx} y={ty + 55} textAnchor="middle" fontSize="9" fill={delta >= 0 ? '#4ade80' : '#f87171'}>
                  {delta >= 0 ? '+' : ''}{delta}% YoY
                </text>
              )}
            </g>
          )
        })()}
      </svg>
      {onMonthClick && <p className="text-xs text-slate-400 text-right mt-1">Cliquer sur une barre pour voir les projets du mois</p>}
    </div>
  )
}

function ClosingRateChart({ data, onMonthClick }) {
  const [tooltip, setTooltip] = useState(null)
  const [activeType, setActiveType] = useState('Tous')

  if (!data || data.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-slate-300 text-sm">
        Pas encore de données (projets gagnés/perdus)
      </div>
    )
  }

  const types = ['Tous', ...Array.from(new Set(data.map(r => r.type).filter(Boolean))).sort()]

  const filtered = activeType === 'Tous' ? data : data.filter(r => r.type === activeType)
  const aggregated = {}
  for (const r of filtered) {
    if (!aggregated[r.month]) aggregated[r.month] = { won: 0, lost: 0 }
    aggregated[r.month].won += r.won
    aggregated[r.month].lost += r.lost
  }

  const months = []
  for (let i = 11; i >= 0; i--) {
    const d = new Date()
    d.setDate(1)
    d.setMonth(d.getMonth() - i)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    const found = aggregated[key]
    const won = found?.won || 0
    const lost = found?.lost || 0
    const total = won + lost
    months.push({
      key,
      label: d.toLocaleDateString('fr-CA', { month: 'short' }),
      rate: total > 0 ? Math.round((won / total) * 100) : null,
      won, lost, total,
    })
  }

  const W = 600, H = 160
  const padL = 36, padR = 16, padT = 12, padB = 28
  const chartW = W - padL - padR
  const chartH = H - padT - padB
  const n = months.length
  const gridLines = [0, 25, 50, 75, 100]

  function xPos(i) { return padL + (i / (n - 1)) * chartW }
  function yPos(v) { return padT + chartH - (v / 100) * chartH }

  const segments = []
  let seg = []
  for (let i = 0; i < months.length; i++) {
    if (months[i].rate !== null) { seg.push(i) }
    else { if (seg.length > 0) { segments.push(seg); seg = [] } }
  }
  if (seg.length > 0) segments.push(seg)

  function linePath(indices) {
    return indices.map((i, j) => `${j === 0 ? 'M' : 'L'} ${xPos(i)} ${yPos(months[i].rate)}`).join(' ')
  }
  function areaPath(indices) {
    if (indices.length < 2) return ''
    const line = indices.map((i, j) => `${j === 0 ? 'M' : 'L'} ${xPos(i)} ${yPos(months[i].rate)}`).join(' ')
    const last = indices[indices.length - 1]
    const first = indices[0]
    return `${line} L ${xPos(last)} ${yPos(0)} L ${xPos(first)} ${yPos(0)} Z`
  }

  return (
    <div className="relative w-full">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="flex gap-1 flex-wrap">
          {types.map(t => (
            <button key={t} onClick={() => setActiveType(t)}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                activeType === t ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
              }`}>
              {t}
            </button>
          ))}
        </div>
        {(() => {
          const recent = months.filter(m => m.total > 0).slice(-3)
          const totalWon = recent.reduce((s, m) => s + m.won, 0)
          const totalAll = recent.reduce((s, m) => s + m.total, 0)
          const avg = totalAll > 0 ? Math.round(totalWon / totalAll * 100) : null
          return avg !== null ? (
            <span className={`text-xl font-bold ${avg >= 60 ? 'text-green-600' : avg >= 40 ? 'text-amber-500' : 'text-red-500'}`}>
              {avg}%
              <span className="text-xs font-normal text-slate-400 ml-1">moy. 3 derniers mois</span>
            </span>
          ) : null
        })()}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 180 }}>
        <defs>
          <linearGradient id="closingGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#21B14B" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#21B14B" stopOpacity="0" />
          </linearGradient>
        </defs>
        {gridLines.map(v => (
          <g key={v}>
            <line x1={padL} x2={W - padR} y1={yPos(v)} y2={yPos(v)}
              stroke={v === 50 ? '#e2e8f0' : '#f1f5f9'} strokeWidth={v === 50 ? 1.5 : 1} strokeDasharray={v === 50 ? '4 3' : ''} />
            <text x={padL - 4} y={yPos(v) + 3.5} textAnchor="end" fontSize="9" fill="#94a3b8">{v}%</text>
          </g>
        ))}
        {segments.map((seg, si) => (
          <path key={`area-${si}`} d={areaPath(seg)} fill="url(#closingGrad)" />
        ))}
        {segments.map((seg, si) => (
          <path key={`line-${si}`} d={linePath(seg)} fill="none" stroke="#21B14B" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        ))}
        {months.map((m, i) => (
          <g key={m.key} onClick={() => m.total > 0 && onMonthClick && onMonthClick(m.key)} style={{ cursor: m.total > 0 && onMonthClick ? 'pointer' : 'default' }}
            onMouseEnter={() => m.rate !== null && setTooltip({ i, x: xPos(i), y: yPos(m.rate), m })}
            onMouseLeave={() => setTooltip(null)}
          >
            {/* invisible hit area for easier clicking */}
            <rect x={xPos(i) - 14} y={padT} width={28} height={chartH + padB} fill="transparent" />
            {m.rate !== null && (
              <circle cx={xPos(i)} cy={yPos(m.rate)} r="4"
                fill={tooltip?.i === i ? '#21B14B' : 'white'} stroke="#21B14B" strokeWidth="2"
                pointerEvents="none"
              />
            )}
            <text x={xPos(i)} y={H - 4} textAnchor="middle" fontSize="9" fill="#94a3b8">{m.label}</text>
          </g>
        ))}
        {tooltip && (() => {
          const tx = Math.min(Math.max(tooltip.x, 60), W - 60)
          const ty = tooltip.y < padT + 40 ? tooltip.y + 16 : tooltip.y - 40
          return (
            <g pointerEvents="none">
              <rect x={tx - 44} y={ty - 14} width={88} height={34} rx="5" fill="#1e293b" opacity="0.92" />
              <text x={tx} y={ty + 1} textAnchor="middle" fontSize="11" fontWeight="bold" fill="white">{tooltip.m.rate}%</text>
              <text x={tx} y={ty + 14} textAnchor="middle" fontSize="9" fill="#94a3b8">
                {tooltip.m.won}G · {tooltip.m.lost}P · {tooltip.m.total} total
              </text>
            </g>
          )
        })()}
      </svg>
    </div>
  )
}

function ShipmentsWeeklyChart({ data }) {
  const navigate = useNavigate()
  const [tooltip, setTooltip] = useState(null)

  if (!data || data.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-slate-300 text-sm">
        Pas encore de données d'envois
      </div>
    )
  }

  // Build last 16 weeks grid (all weeks, even empty ones)
  const weeks = []
  for (let i = 15; i >= 0; i--) {
    const d = new Date()
    // go back i weeks from current Monday
    const day = d.getDay()
    const monday = new Date(d)
    monday.setDate(d.getDate() - ((day + 6) % 7) - i * 7)
    monday.setHours(0, 0, 0, 0)
    const key = monday.toISOString().slice(0, 10)
    const found = data.find(r => r.week_start === key)
    weeks.push({ key, date: monday, count: found?.count || 0 })
  }

  const maxCount = Math.max(...weeks.map(w => w.count), 1)

  const W = 600, H = 160
  const padL = 28, padR = 8, padT = 12, padB = 28
  const chartW = W - padL - padR
  const chartH = H - padT - padB
  const n = weeks.length
  const barW = Math.floor(chartW / n) - 4

  function xCenter(i) { return padL + (i + 0.5) * (chartW / n) }
  function barHeight(count) { return (count / maxCount) * chartH }

  const gridCounts = [0, Math.round(maxCount / 2), maxCount].filter((v, i, a) => a.indexOf(v) === i)

  return (
    <div className="relative w-full">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 180 }}>
        <defs>
          <linearGradient id="shipmentsGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#21B14B" stopOpacity="0.9" />
            <stop offset="100%" stopColor="#21B14B" stopOpacity="0.5" />
          </linearGradient>
          <linearGradient id="shipmentsGradHover" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#1B8E3C" stopOpacity="1" />
            <stop offset="100%" stopColor="#1B8E3C" stopOpacity="0.7" />
          </linearGradient>
        </defs>
        {gridCounts.map(v => {
          const y = padT + chartH - (v / maxCount) * chartH
          return (
            <g key={v}>
              <line x1={padL} x2={W - padR} y1={y} y2={y} stroke="#f1f5f9" strokeWidth={1} />
              <text x={padL - 4} y={y + 3.5} textAnchor="end" fontSize="9" fill="#94a3b8">{v}</text>
            </g>
          )
        })}
        {weeks.map((w, i) => {
          const bh = barHeight(w.count)
          const x = xCenter(i) - barW / 2
          const y = padT + chartH - bh
          const isHovered = tooltip?.i === i
          const showLabel = i === 0 || i === n - 1 || w.date.getDate() <= 7
          const label = w.date.toLocaleDateString('fr-CA', { month: 'short', day: 'numeric' })
          return (
            <g key={w.key}
              style={{ cursor: w.count > 0 ? 'pointer' : 'default' }}
              onClick={() => w.count > 0 && navigate(`/envois?week=${w.key}`)}
              onMouseEnter={() => setTooltip({ i, x: xCenter(i), y: bh > 0 ? y : padT + chartH - 20, w })}
              onMouseLeave={() => setTooltip(null)}
            >
              {/* invisible hit area */}
              <rect x={padL + i * (chartW / n)} y={0} width={chartW / n} height={H} fill="transparent" />
              {bh > 0 && (
                <rect
                  x={x} y={y} width={barW} height={bh}
                  rx="3"
                  fill={isHovered ? 'url(#shipmentsGradHover)' : 'url(#shipmentsGrad)'}
                />
              )}
              {showLabel && (
                <text x={xCenter(i)} y={H - 4} textAnchor="middle" fontSize="8" fill="#94a3b8">
                  {label}
                </text>
              )}
            </g>
          )
        })}
        {tooltip && (() => {
          const tx = Math.min(Math.max(tooltip.x, 60), W - 60)
          const ty = Math.max(tooltip.y - 8, padT + 4)
          const label = tooltip.w.date.toLocaleDateString('fr-CA', { month: 'short', day: 'numeric' })
          return (
            <g pointerEvents="none">
              <rect x={tx - 44} y={ty - 14} width={88} height={34} rx="5" fill="#1e293b" opacity="0.92" />
              <text x={tx} y={ty + 1} textAnchor="middle" fontSize="11" fontWeight="bold" fill="white">
                {tooltip.w.count} colis
              </text>
              <text x={tx} y={ty + 14} textAnchor="middle" fontSize="9" fill="#94a3b8">
                Sem. du {label}
              </text>
            </g>
          )
        })()}
      </svg>
      <p className="text-xs text-slate-400 text-right mt-1">Cliquer sur une barre pour voir les envois</p>
    </div>
  )
}

function ShippingCostChart({ data }) {
  const [tooltip, setTooltip] = useState(null)
  const navigate = useNavigate()

  if (!data || data.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-slate-300 text-sm">
        Pas encore de données d'expédition
      </div>
    )
  }

  // Build last 4 weeks grid (28 jours)
  const weeks = []
  for (let i = 3; i >= 0; i--) {
    const d = new Date()
    const day = d.getDay()
    const monday = new Date(d)
    monday.setDate(d.getDate() - ((day + 6) % 7) - i * 7)
    monday.setHours(0, 0, 0, 0)
    const key = monday.toISOString().slice(0, 10)
    const found = data.find(r => r.week_start === key)
    weeks.push({ key, date: monday, amount: found?.amount || 0 })
  }

  const maxVal = Math.max(...weeks.map(w => w.amount), 1)

  const W = 700, H = 220
  const padL = 50, padR = 16, padT = 16, padB = 36
  const chartW = W - padL - padR
  const chartH = H - padT - padB
  const n = weeks.length
  const barW = Math.max(Math.floor(chartW / n) - 24, 24)

  function xCenter(i) { return padL + (i + 0.5) * (chartW / n) }
  function yPos(v) { return padT + chartH - (v / maxVal) * chartH }

  const fmtK = v => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`

  // Grid lines
  const gridStep = maxVal > 2000 ? 500 : maxVal > 1000 ? 250 : maxVal > 400 ? 100 : 50
  const gridLines = []
  for (let v = 0; v <= maxVal; v += gridStep) gridLines.push(v)

  return (
    <div>
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 200 }}>
          <defs>
            <linearGradient id="shippingBarGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.85" />
              <stop offset="100%" stopColor="#f59e0b" stopOpacity="0.4" />
            </linearGradient>
            <linearGradient id="shippingBarGradHover" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#d97706" stopOpacity="1" />
              <stop offset="100%" stopColor="#d97706" stopOpacity="0.6" />
            </linearGradient>
          </defs>

          {/* Grid */}
          {gridLines.map(v => {
            const y = yPos(v)
            return (
              <g key={v}>
                <line x1={padL} x2={W - padR} y1={y} y2={y} stroke="#f1f5f9" strokeWidth={1} />
                <text x={padL - 4} y={y + 3.5} textAnchor="end" fontSize="9" fill="#94a3b8">{fmtK(v)}$</text>
              </g>
            )
          })}

          {/* Bars */}
          {weeks.map((w, i) => {
            const bh = w.amount > 0 ? Math.max((w.amount / maxVal) * chartH, 2) : 0
            const x = xCenter(i) - barW / 2
            const y = padT + chartH - bh
            const isHovered = tooltip?.i === i
            const label = w.date.toLocaleDateString('fr-CA', { weekday: 'short', day: 'numeric', month: 'short' })
            const windowStart = new Date(w.date); windowStart.setDate(w.date.getDate() - 27)
            const fromIso = windowStart.toISOString().slice(0, 10)
            const toIso = w.date.toISOString().slice(0, 10)
            const handleClick = () => navigate(`/achats-fournisseurs?from=${fromIso}&to=${toIso}&account=Expédition`)
            return (
              <g key={w.key}
                onMouseEnter={() => setTooltip({ i, x: xCenter(i), y, w })}
                onMouseLeave={() => setTooltip(null)}
                onClick={handleClick}
                style={{ cursor: 'pointer' }}
                data-testid={`shipping-bar-${i}`}
              >
                <rect x={padL + i * (chartW / n)} y={0} width={chartW / n} height={H} fill="transparent" />
                {bh > 0 && (
                  <rect x={x} y={y} width={barW} height={bh} rx="3"
                    fill={isHovered ? 'url(#shippingBarGradHover)' : 'url(#shippingBarGrad)'} />
                )}
                {bh > 0 && (
                  <text x={xCenter(i)} y={y - 6} textAnchor="middle" fontSize="11" fontWeight="600" fill="#475569">
                    {fmtCad(w.amount)}
                  </text>
                )}
                <text x={xCenter(i)} y={H - 6} textAnchor="middle" fontSize="10" fill="#64748b">
                  {label}
                </text>
              </g>
            )
          })}

          {/* Tooltip */}
          {tooltip && (() => {
            const tx = Math.min(Math.max(tooltip.x, 70), W - 70)
            const ty = Math.max(tooltip.y - 8, padT + 4)
            const label = tooltip.w.date.toLocaleDateString('fr-CA', { month: 'short', day: 'numeric' })
            return (
              <g pointerEvents="none">
                <rect x={tx - 56} y={ty - 14} width={112} height={34} rx="5" fill="#1e293b" opacity="0.93" />
                <text x={tx} y={ty + 1} textAnchor="middle" fontSize="11" fontWeight="bold" fill="#fbbf24">
                  {fmtCad(tooltip.w.amount)}
                </text>
                <text x={tx} y={ty + 14} textAnchor="middle" fontSize="9" fill="#94a3b8">
                  28j au {label}
                </text>
              </g>
            )
          })()}
        </svg>
      </div>
    </div>
  )
}

function pct(num, total) {
  if (!total) return null
  return Math.round((num / total) * 100)
}

function PctCell({ value, invert = false }) {
  if (value === null) return <td className="px-3 py-2.5 text-center text-slate-300 text-sm">—</td>
  const good = invert ? value <= 20 : value >= 60
  const warn = invert ? value <= 40 : value >= 30
  const cls = good ? 'text-green-600 font-semibold' : warn ? 'text-amber-500 font-medium' : 'text-red-500 font-medium'
  return <td className={`px-3 py-2.5 text-center text-sm tabular-nums ${cls}`}>{value}%</td>
}

function SupportWeeklyTable({ data }) {
  if (!data || data.length === 0) {
    return (
      <div className="flex items-center justify-center h-24 text-slate-300 text-sm">
        Pas encore de données
      </div>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-100">
            <th className="px-3 py-2 text-left text-xs font-semibold text-slate-400 uppercase tracking-wide">Semaine</th>
            <th className="px-3 py-2 text-center text-xs font-semibold text-slate-400 uppercase tracking-wide">Billets</th>
            <th className="px-3 py-2 text-center text-xs font-semibold text-slate-400 uppercase tracking-wide">Ligne 2</th>
            <th className="px-3 py-2 text-center text-xs font-semibold text-slate-400 uppercase tracking-wide">&gt; 15 min</th>
            <th className="px-3 py-2 text-center text-xs font-semibold text-slate-400 uppercase tracking-wide">Arbre troubleshoot</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-50">
          {data.map(row => {
            const weekDate = new Date(row.week_start + 'T12:00:00')
            const endDate = new Date(weekDate)
            endDate.setDate(weekDate.getDate() + 6)
            const label = weekDate.toLocaleDateString('fr-CA', { month: 'short', day: 'numeric' }) +
              ' – ' + endDate.toLocaleDateString('fr-CA', { month: 'short', day: 'numeric' })
            const pctIssue = pct(row.with_issue, row.total)
            const pct15 = pct(row.over_15min, row.total)
            const pctArbre = pct(row.with_arbre, row.total)
            return (
              <tr key={row.week_start} className="hover:bg-slate-50 transition-colors">
                <td className="px-3 py-2.5 text-slate-600 whitespace-nowrap">{label}</td>
                <td className="px-3 py-2.5 text-center font-semibold text-slate-900 tabular-nums">{row.total}</td>
                <PctCell value={pctIssue} invert={true} />
                <PctCell value={pct15} invert={true} />
                <PctCell value={pctArbre} invert={false} />
              </tr>
            )
          })}
        </tbody>
      </table>
      <div className="mt-3 flex flex-wrap gap-4 text-xs text-slate-400 px-3 pb-1">
        <span><span className="text-green-600 font-semibold">Vert</span> = bon</span>
        <span><span className="text-amber-500 font-medium">Jaune</span> = à surveiller</span>
        <span><span className="text-red-500 font-medium">Rouge</span> = à améliorer</span>
        <span className="ml-auto">Ligne 2 / &gt;15 min : vert si ≤ 20%, rouge si &gt; 40% · Arbre : vert si ≥ 60%</span>
      </div>
    </div>
  )
}

function ProfitabilityChart({ data, recentOrders }) {
  const navigate = useNavigate()
  const [tooltip, setTooltip] = useState(null)
  const [activeFilter, setActiveFilter] = useState('Tous') // 'Tous' | 'Abonnement' | 'Achat'
  const [showOrders, setShowOrders] = useState(false)
  const [selectedWeek, setSelectedWeek] = useState(null)

  // Build last 16 weeks grid, merging rows by is_subscription
  const weeks = []
  for (let i = 15; i >= 0; i--) {
    const d = new Date()
    const day = d.getDay()
    const monday = new Date(d)
    monday.setDate(d.getDate() - ((day + 6) % 7) - i * 7)
    monday.setHours(0, 0, 0, 0)
    const key = monday.toISOString().slice(0, 10)
    const rows = data?.filter(r => r.week_start === key) || []
    const sub  = rows.find(r => r.is_subscription === 1)
    const achat = rows.find(r => r.is_subscription === 0)
    const totalRevenue = (sub?.revenue || 0) + (achat?.revenue || 0)
    const totalCogs    = (sub?.cogs || 0)    + (achat?.cogs || 0)

    let revenue = totalRevenue, cogs = totalCogs
    if (activeFilter === 'Abonnement') { revenue = sub?.revenue || 0; cogs = sub?.cogs || 0 }
    if (activeFilter === 'Achat')      { revenue = achat?.revenue || 0; cogs = achat?.cogs || 0 }

    weeks.push({ key, date: monday, revenue, cogs,
      subRevenue: sub?.revenue || 0, subCogs: sub?.cogs || 0,
      achatRevenue: achat?.revenue || 0, achatCogs: achat?.cogs || 0 })
  }

  // 28-day rolling = last 4 weeks
  const last4 = weeks.slice(-4)
  const rolling28Revenue = last4.reduce((s, w) => s + w.revenue, 0)
  const rolling28Cogs    = last4.reduce((s, w) => s + w.cogs, 0)
  const rolling28Margin  = rolling28Revenue - rolling28Cogs
  const rolling28Pct     = rolling28Revenue > 0 ? Math.round((rolling28Margin / rolling28Revenue) * 100) : null

  // Sub vs Achat breakdown for 28j
  const subRevenue28   = last4.reduce((s, w) => s + w.subRevenue, 0)
  const achatRevenue28 = last4.reduce((s, w) => s + w.achatRevenue, 0)

  // Compute margin % per week
  const weekMargins = weeks.map(w => w.revenue > 0 ? Math.round(((w.revenue - w.cogs) / w.revenue) * 100) : null)

  const W = 600, H = 160
  const padL = 32, padR = 8, padT = 12, padB = 28
  const chartW = W - padL - padR
  const chartH = H - padT - padB
  const n = weeks.length

  // Y-axis range: 0% to max margin (at least 60%)
  const validMargins = weekMargins.filter(m => m !== null)
  const minPct = Math.min(0, ...validMargins)
  const maxPct = Math.max(60, ...validMargins)
  const rangePct = maxPct - minPct

  function xPos(i) { return padL + (i + 0.5) * (chartW / n) }
  function yPos(pct) { return padT + chartH - ((pct - minPct) / rangePct) * chartH }

  const fmtK = v => v >= 1000 ? `${Math.round(v / 1000)}k` : `${Math.round(v)}`

  if (!data || data.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-slate-300 text-sm">
        Pas encore de données (commandes au statut Envoyé requises)
      </div>
    )
  }

  return (
    <div>
      {/* Filter tabs */}
      <div className="flex gap-1 mb-4">
        {['Tous', 'Abonnement', 'Achat'].map(f => (
          <button key={f} onClick={() => setActiveFilter(f)}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
              activeFilter === f
                ? f === 'Abonnement' ? 'bg-violet-600 text-white' : f === 'Achat' ? 'bg-brand-600 text-white' : 'bg-slate-700 text-white'
                : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
            }`}>
            {f}
          </button>
        ))}
      </div>

      {/* 28-day rolling summary */}
      <div className="grid grid-cols-3 gap-3 mb-5">
        <div className="bg-slate-50 rounded-xl p-4">
          <p className="text-xs text-slate-500 mb-1">Revenus 28j</p>
          <p className="text-xl font-bold text-slate-900">{fmtCad(rolling28Revenue)}</p>
          {activeFilter === 'Tous' && (rolling28Revenue > 0) && (
            <div className="flex gap-2 mt-1 text-xs text-slate-400">
              <span className="text-violet-500">{fmtCad(subRevenue28)} abo</span>
              <span className="text-brand-500">{fmtCad(achatRevenue28)} achat</span>
            </div>
          )}
        </div>
        <div className="bg-slate-50 rounded-xl p-4">
          <p className="text-xs text-slate-500 mb-1">Coûts 28j</p>
          <p className="text-xl font-bold text-slate-700">{fmtCad(rolling28Cogs)}</p>
        </div>
        <div className="bg-slate-50 rounded-xl p-4">
          <p className="text-xs text-slate-500 mb-1">Marge brute 28j</p>
          <div className="flex items-baseline gap-2">
            <p className={`text-xl font-bold ${rolling28Margin >= 0 ? 'text-green-600' : 'text-red-500'}`}>
              {fmtCad(rolling28Margin)}
            </p>
            {rolling28Pct !== null && (
              <span className={`text-sm font-semibold ${rolling28Pct >= 40 ? 'text-green-500' : rolling28Pct >= 20 ? 'text-amber-500' : 'text-red-500'}`}>
                {rolling28Pct}%
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Weekly line chart — margin % */}
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 180 }}>
          <defs>
            <linearGradient id="marginFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#10b981" stopOpacity="0.15" />
              <stop offset="100%" stopColor="#10b981" stopOpacity="0.02" />
            </linearGradient>
          </defs>

          {/* Grid lines */}
          {[0, 20, 40, 60].filter(v => v >= minPct && v <= maxPct).map(v => {
            const y = yPos(v)
            return (
              <g key={v}>
                <line x1={padL} x2={W - padR} y1={y} y2={y} stroke={v === 0 ? '#cbd5e1' : '#f1f5f9'} strokeWidth={v === 0 ? 0.8 : 1} />
                <text x={padL - 4} y={y + 3.5} textAnchor="end" fontSize="9" fill="#94a3b8">{v}%</text>
              </g>
            )
          })}

          {/* Area fill under the line */}
          {(() => {
            const points = weeks.map((w, i) => weekMargins[i] !== null ? { x: xPos(i), y: yPos(weekMargins[i]) } : null).filter(Boolean)
            if (points.length < 2) return null
            const areaPath = `M${points[0].x},${points[0].y} ${points.map(p => `L${p.x},${p.y}`).join(' ')} L${points[points.length - 1].x},${yPos(0)} L${points[0].x},${yPos(0)} Z`
            return <path d={areaPath} fill="url(#marginFill)" />
          })()}

          {/* Line */}
          {(() => {
            const points = weeks.map((w, i) => weekMargins[i] !== null ? `${xPos(i)},${yPos(weekMargins[i])}` : null).filter(Boolean)
            if (points.length < 2) return null
            return <polyline points={points.join(' ')} fill="none" stroke="#10b981" strokeWidth="2" strokeLinejoin="round" />
          })()}

          {/* Points + hover zones */}
          {weeks.map((w, i) => {
            if (weekMargins[i] === null) return null
            const cx = xPos(i)
            const cy = yPos(weekMargins[i])
            const isHovered = tooltip?.i === i
            const isSelected = selectedWeek === w.key
            const isLast4 = i >= n - 4
            const showLabel = i === 0 || i === n - 1 || w.date.getDate() <= 7
            const label = w.date.toLocaleDateString('fr-CA', { month: 'short', day: 'numeric' })
            const color = weekMargins[i] >= 40 ? '#10b981' : weekMargins[i] >= 20 ? '#f59e0b' : '#ef4444'
            return (
              <g key={w.key}
                data-testid={`profitability-week-${w.key}`}
                onMouseEnter={() => setTooltip({ i, x: cx, y: cy, w, pct: weekMargins[i] })}
                onMouseLeave={() => setTooltip(null)}
                onClick={() => {
                  setSelectedWeek(prev => prev === w.key ? null : w.key)
                  setShowOrders(true)
                }}
                style={{ cursor: 'pointer' }}
              >
                <rect x={padL + i * (chartW / n)} y={0} width={chartW / n} height={H} fill="transparent" />
                <circle
                  cx={cx}
                  cy={cy}
                  r={isSelected || isHovered ? 5 : 3.5}
                  fill={color}
                  stroke={isSelected ? '#0f172a' : 'white'}
                  strokeWidth={isSelected ? 2.5 : (isHovered ? 2 : 1.5)}
                  opacity={isLast4 || isSelected ? 1 : 0.5}
                />
                {showLabel && (
                  <text x={cx} y={H - 4} textAnchor="middle" fontSize="8" fontWeight={isSelected ? 'bold' : 'normal'} fill={isSelected ? '#0f172a' : '#94a3b8'}>{label}</text>
                )}
              </g>
            )
          })}

          {/* Tooltip */}
          {tooltip && (() => {
            const tx = Math.min(Math.max(tooltip.x, 70), W - 70)
            const ty = Math.max(tooltip.y - 8, padT + 4)
            const w = tooltip.w
            const label = w.date.toLocaleDateString('fr-CA', { month: 'short', day: 'numeric' })
            const hasBreakdown = activeFilter === 'Tous' && (w.subRevenue > 0 || w.achatRevenue > 0)
            const tooltipH = hasBreakdown ? 82 : 66
            return (
              <g pointerEvents="none">
                <rect x={tx - 64} y={ty - 14} width={128} height={tooltipH} rx="5" fill="#1e293b" opacity="0.93" />
                <text x={tx} y={ty + 2} textAnchor="middle" fontSize="9" fill="#94a3b8">
                  Sem. du {label}
                </text>
                <text x={tx} y={ty + 16} textAnchor="middle" fontSize="10" fontWeight="bold"
                  fill={tooltip.pct >= 40 ? '#6ee7b7' : tooltip.pct >= 20 ? '#fbbf24' : '#f87171'}>
                  Marge: {tooltip.pct}%
                </text>
                <text x={tx} y={ty + 30} textAnchor="middle" fontSize="10" fill="#6ee7b7">
                  Rev: {fmtK(w.revenue)}$
                </text>
                <text x={tx} y={ty + 44} textAnchor="middle" fontSize="10" fill="#94a3b8">
                  Coûts: {fmtK(w.cogs)}$
                </text>
                {hasBreakdown && (
                  <text x={tx} y={ty + 60} textAnchor="middle" fontSize="9" fill="#a78bfa">
                    Abo {fmtK(w.subRevenue)}$ · Achat {fmtK(w.achatRevenue)}$
                  </text>
                )}
              </g>
            )
          })()}
        </svg>
        <div className="flex items-center gap-4 text-xs text-slate-400 mt-1 px-1">
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block" /> Marge %</span>
          <span className="ml-auto">Points opaques = 28 derniers jours</span>
        </div>
      </div>

      {/* Shipped orders table — filtered by activeFilter and (optionally) selectedWeek */}
      {recentOrders?.length > 0 && (() => {
        const byType = activeFilter === 'Tous' ? recentOrders
          : activeFilter === 'Abonnement' ? recentOrders.filter(o => o.is_subscription)
          : recentOrders.filter(o => !o.is_subscription)

        let weekStart = null, weekEnd = null, weekLabel = null
        if (selectedWeek) {
          const [yr, mo, dy] = selectedWeek.split('-').map(Number)
          weekStart = new Date(yr, mo - 1, dy)
          weekEnd = new Date(weekStart.getTime() + 7 * 86400000)
          weekLabel = weekStart.toLocaleDateString('fr-CA', { month: 'short', day: 'numeric', year: 'numeric' })
        }
        const filtered = selectedWeek
          ? byType.filter(o => {
              if (!o.last_shipped_at) return false
              const t = new Date(o.last_shipped_at).getTime()
              return t >= weekStart.getTime() && t < weekEnd.getTime()
            })
          : byType

        if (!byType.length && !selectedWeek) return null
        return (
          <div className="mt-6 border-t border-slate-100 pt-5">
            <div className="flex items-center gap-3">
              <button
                onClick={() => setShowOrders(!showOrders)}
                className="text-sm text-blue-600 hover:text-blue-800 font-medium flex items-center gap-1"
              >
                <span className="text-xs">{showOrders ? '▼' : '▶'}</span>
                {selectedWeek
                  ? `Commandes — semaine du ${weekLabel} (${filtered.length})`
                  : `Commandes envoyées — 28 derniers jours (${filtered.length})`}
              </button>
              {selectedWeek && (
                <button
                  data-testid="profitability-filter-clear"
                  onClick={() => setSelectedWeek(null)}
                  className="text-xs text-slate-500 hover:text-slate-700 underline"
                >
                  Effacer le filtre
                </button>
              )}
            </div>
            {showOrders && <div className="overflow-x-auto mt-3">
              <table className="w-full text-sm" data-testid="profitability-orders-table">
                <thead>
                  <tr className="border-b border-slate-100">
                    <th className="px-3 py-2 text-left text-xs font-semibold text-slate-400 uppercase tracking-wide">#</th>
                    <th className="px-3 py-2 text-left text-xs font-semibold text-slate-400 uppercase tracking-wide">Entreprise</th>
                    <th className="px-3 py-2 text-left text-xs font-semibold text-slate-400 uppercase tracking-wide">Type</th>
                    <th className="px-3 py-2 text-left text-xs font-semibold text-slate-400 uppercase tracking-wide">Dernier envoi</th>
                    <th className="px-3 py-2 text-right text-xs font-semibold text-slate-400 uppercase tracking-wide">Revenus</th>
                    <th className="px-3 py-2 text-right text-xs font-semibold text-slate-400 uppercase tracking-wide">Coûts</th>
                    <th className="px-3 py-2 text-right text-xs font-semibold text-slate-400 uppercase tracking-wide">Marge</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {filtered.map(order => {
                    const margin = (order.revenue || 0) - (order.cogs || 0)
                    const marginPct = order.revenue > 0 ? Math.round((margin / order.revenue) * 100) : null
                    return (
                      <tr key={order.id}
                        onClick={() => navigate(`/orders/${order.id}`)}
                        className="hover:bg-slate-50 cursor-pointer transition-colors"
                      >
                        <td className="px-3 py-2.5 font-mono font-medium text-slate-900">#{order.order_number}</td>
                        <td className="px-3 py-2.5 text-slate-700">{order.company_name || <span className="text-slate-400">—</span>}</td>
                        <td className="px-3 py-2.5">
                          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${order.is_subscription ? 'bg-violet-100 text-violet-700' : 'bg-slate-100 text-slate-500'}`}>
                            {order.is_subscription ? 'Abonnement' : 'Achat'}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-slate-500 whitespace-nowrap">{fmtDateShort(order.last_shipped_at)}</td>
                        <td className="px-3 py-2.5 text-right font-medium text-slate-700 tabular-nums">{fmtCad(order.revenue)}</td>
                        <td className="px-3 py-2.5 text-right text-slate-500 tabular-nums">{fmtCad(order.cogs)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">
                          <span className={`font-semibold ${marginPct === null ? 'text-slate-400' : marginPct >= 40 ? 'text-green-600' : marginPct >= 20 ? 'text-amber-500' : 'text-red-500'}`}>
                            {marginPct !== null ? `${marginPct}%` : '—'}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-3 py-4 text-center text-slate-400 text-sm">
                        {selectedWeek
                          ? `Aucune commande envoyée la semaine du ${weekLabel}${weekEnd && weekEnd.getTime() < Date.now() - 28 * 86400000 ? ' (au-delà de la fenêtre 28 jours du tableau)' : ''}`
                          : 'Aucune commande'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>}
          </div>
        )
      })()}
    </div>
  )
}

function ReplacementRateChart({ replacementRate }) {
  const [tooltip, setTooltip] = useState(null)
  const [showItems, setShowItems] = useState(false)
  const [selectedMonth, setSelectedMonth] = useState(null)
  const { parkValue = 0, last28 = 0, byMonth = [], items = [] } = replacementRate || {}

  const filteredItems = selectedMonth
    ? items.filter(it => {
        if (!it.shipped_at) return false
        const d = new Date(it.shipped_at)
        const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
        return k === selectedMonth
      })
    : items
  const selectedMonthLabel = selectedMonth
    ? (() => {
        const [yr, mo] = selectedMonth.split('-').map(Number)
        return new Date(yr, mo - 1, 1).toLocaleDateString('fr-CA', { month: 'long', year: 'numeric' })
      })()
    : null

  // Build last 12 months grid
  const months = []
  for (let i = 11; i >= 0; i--) {
    const d = new Date()
    d.setDate(1)
    d.setMonth(d.getMonth() - i)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    const found = byMonth.find(r => r.month === key)
    const cost = found?.replacement_cost || 0
    const rate = parkValue > 0 ? (cost / parkValue) * 100 : 0
    months.push({ key, label: d.toLocaleDateString('fr-CA', { month: 'short' }), cost, rate, nb_orders: found?.nb_orders || 0 })
  }

  const last28Cost = last28
  const last28Rate = parkValue > 0 ? (last28Cost / parkValue) * 100 : 0
  const totalLast12 = byMonth.reduce((s, m) => s + (m.replacement_cost || 0), 0)
  const annualized = parkValue > 0 ? (totalLast12 / parkValue) * 100 : 0

  const W = 600, H = 160
  const padL = 44, padR = 8, padT = 12, padB = 28
  const chartW = W - padL - padR
  const chartH = H - padT - padB
  const n = months.length
  const maxRate = Math.max(...months.map(m => m.rate), 0.5)
  function xPos(i) { return padL + (i + 0.5) * (chartW / n) }
  function yPos(val) { return padT + chartH - (val / maxRate) * chartH }
  const fmtPct = v => v.toFixed(2) + '%'

  return (
    <div>
      {/* Summary cards */}
      <div className="grid grid-cols-4 gap-3 mb-5">
        <div className="bg-slate-50 rounded-xl p-4">
          <p className="text-xs text-slate-500 mb-1">Valeur parc opérationnel</p>
          <p className="text-xl font-bold text-slate-900">{fmtCad(parkValue)}</p>
          <p className="text-xs text-slate-400 mt-1">Loués + vendus sous garantie</p>
        </div>
        <div className="bg-slate-50 rounded-xl p-4">
          <p className="text-xs text-slate-500 mb-1">Coût remplacements 28j</p>
          <p className="text-xl font-bold text-amber-600">{fmtCad(last28Cost)}</p>
          <p className="text-xs text-slate-400 mt-1">{fmtPct(last28Rate)} du parc</p>
        </div>
        <div className="bg-slate-50 rounded-xl p-4">
          <p className="text-xs text-slate-500 mb-1">Coût remplacements 365j</p>
          <p className="text-xl font-bold text-amber-600">{fmtCad(totalLast12)}</p>
          <p className="text-xs text-slate-400 mt-1">{fmtPct(parkValue > 0 ? (totalLast12 / parkValue) * 100 : 0)} du parc</p>
        </div>
        <div className="bg-slate-50 rounded-xl p-4">
          <p className="text-xs text-slate-500 mb-1">Taux annualisé</p>
          <p className={`text-xl font-bold ${annualized <= 5 ? 'text-green-600' : annualized <= 10 ? 'text-amber-500' : 'text-red-500'}`}>
            {fmtPct(annualized)}
          </p>
          <p className="text-xs text-slate-400 mt-1">Moyenne 12 derniers mois</p>
        </div>
      </div>

      {/* Monthly line chart — replacement rate % */}
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 180 }}>
          <defs>
            <linearGradient id="replFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.15" />
              <stop offset="100%" stopColor="#f59e0b" stopOpacity="0.02" />
            </linearGradient>
          </defs>

          {/* Grid lines */}
          {(() => {
            const step = maxRate > 1 ? Math.ceil(maxRate / 3 * 10) / 10 : maxRate / 3
            const vals = [0, step, step * 2, maxRate]
            return vals.map((v, gi) => {
              const y = yPos(v)
              return (
                <g key={gi}>
                  <line x1={padL} x2={W - padR} y1={y} y2={y} stroke={v === 0 ? '#cbd5e1' : '#f1f5f9'} strokeWidth={v === 0 ? 0.8 : 1} />
                  <text x={padL - 4} y={y + 3.5} textAnchor="end" fontSize="9" fill="#94a3b8">{v.toFixed(v >= 1 ? 1 : 2)}%</text>
                </g>
              )
            })
          })()}

          {/* Area fill */}
          {(() => {
            const points = months.map((m, i) => ({ x: xPos(i), y: yPos(m.rate) }))
            const areaPath = `M${points[0].x},${points[0].y} ${points.map(p => `L${p.x},${p.y}`).join(' ')} L${points[points.length - 1].x},${yPos(0)} L${points[0].x},${yPos(0)} Z`
            return <path d={areaPath} fill="url(#replFill)" />
          })()}

          {/* Line */}
          {(() => {
            const points = months.map((m, i) => `${xPos(i)},${yPos(m.rate)}`)
            return <polyline points={points.join(' ')} fill="none" stroke="#f59e0b" strokeWidth="2" strokeLinejoin="round" />
          })()}

          {/* Points + hover zones */}
          {months.map((m, i) => {
            const cx = xPos(i)
            const cy = yPos(m.rate)
            const isHovered = tooltip?.i === i
            const isSelected = selectedMonth === m.key
            return (
              <g key={m.key}
                data-testid={`replacement-month-${m.key}`}
                onMouseEnter={() => setTooltip({ i, x: cx, y: cy, m })}
                onMouseLeave={() => setTooltip(null)}
                onClick={() => {
                  setSelectedMonth(prev => prev === m.key ? null : m.key)
                  setShowItems(true)
                }}
                style={{ cursor: 'pointer' }}
              >
                <rect x={padL + i * (chartW / n)} y={0} width={chartW / n} height={H} fill="transparent" />
                <circle
                  cx={cx}
                  cy={cy}
                  r={isSelected || isHovered ? 5 : 3.5}
                  fill={isSelected ? '#d97706' : '#f59e0b'}
                  stroke="white"
                  strokeWidth={isSelected ? 2.5 : (isHovered ? 2 : 1.5)}
                />
                <text x={cx} y={H - 4} textAnchor="middle" fontSize="9" fontWeight={isSelected ? 'bold' : 'normal'} fill={isSelected ? '#d97706' : '#94a3b8'}>{m.label}</text>
              </g>
            )
          })}

          {/* Tooltip */}
          {tooltip && (() => {
            const tx = Math.min(Math.max(tooltip.x, 70), W - 70)
            const ty = Math.max(tooltip.y - 8, padT + 4)
            return (
              <g pointerEvents="none">
                <rect x={tx - 56} y={ty - 14} width={112} height={66} rx="5" fill="#1e293b" opacity="0.93" />
                <text x={tx} y={ty + 2} textAnchor="middle" fontSize="9" fill="#94a3b8">
                  {(() => {
                    const [yr, mo] = tooltip.m.key.split('-').map(Number)
                    return new Date(yr, mo - 1, 1).toLocaleDateString('fr-CA', { month: 'long', year: 'numeric' })
                  })()}
                </text>
                <text x={tx} y={ty + 16} textAnchor="middle" fontSize="10" fontWeight="bold" fill="#fbbf24">
                  {fmtPct(tooltip.m.rate)} du parc
                </text>
                <text x={tx} y={ty + 30} textAnchor="middle" fontSize="10" fill="#94a3b8">
                  {fmtCad(tooltip.m.cost)}
                </text>
                <text x={tx} y={ty + 44} textAnchor="middle" fontSize="9" fill="#94a3b8">
                  {tooltip.m.nb_orders} commande{tooltip.m.nb_orders > 1 ? 's' : ''}
                </text>
              </g>
            )
          })()}
        </svg>
        <div className="flex items-center gap-4 text-xs text-slate-400 mt-1 px-1">
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-amber-500 inline-block" /> Taux de remplacement %</span>
        </div>
      </div>

      {/* Replacement items detail table */}
      {items.length > 0 && (
        <div className="mt-4">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowItems(!showItems)}
              className="text-sm text-blue-600 hover:text-blue-800 font-medium flex items-center gap-1"
            >
              <span className="text-xs">{showItems ? '▼' : '▶'}</span>
              {selectedMonth
                ? `${filteredItems.length} ligne${filteredItems.length > 1 ? 's' : ''} pour ${selectedMonthLabel}`
                : `${items.length} ligne${items.length > 1 ? 's' : ''} de remplacement (12 derniers mois)`}
            </button>
            {selectedMonth && (
              <button
                data-testid="replacement-filter-clear"
                onClick={() => setSelectedMonth(null)}
                className="text-xs text-slate-500 hover:text-slate-700 underline"
              >
                Effacer le filtre
              </button>
            )}
          </div>
          {showItems && (
            <div className="mt-2 border border-slate-200 rounded-lg overflow-hidden">
              <table className="w-full text-sm" data-testid="replacement-items-table">
                <thead>
                  <tr className="bg-slate-50 text-left text-xs text-slate-500">
                    <th className="px-3 py-2 font-medium">Commande</th>
                    <th className="px-3 py-2 font-medium">Client</th>
                    <th className="px-3 py-2 font-medium">Produit</th>
                    <th className="px-3 py-2 font-medium text-center">Qté</th>
                    <th className="px-3 py-2 font-medium text-right">Coût unit.</th>
                    <th className="px-3 py-2 font-medium text-right">Total</th>
                    <th className="px-3 py-2 font-medium text-right">Date d'envoi</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredItems.map((it, idx) => (
                    <tr key={idx} className={idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'}>
                      <td className="px-3 py-1.5 text-slate-700 font-mono text-xs">#{it.order_number}</td>
                      <td className="px-3 py-1.5 text-slate-700">{it.company_name || '—'}</td>
                      <td className="px-3 py-1.5 text-slate-700">{it.product_name || '—'}</td>
                      <td className="px-3 py-1.5 text-center text-slate-600">{it.qty}</td>
                      <td className="px-3 py-1.5 text-right text-slate-600">{fmtCad(it.unit_cost)}</td>
                      <td className="px-3 py-1.5 text-right font-medium text-amber-700">{fmtCad(it.total_cost)}</td>
                      <td className="px-3 py-1.5 text-right text-slate-500">{it.shipped_at ? new Date(it.shipped_at).toLocaleDateString('fr-CA') : '—'}</td>
                    </tr>
                  ))}
                  {filteredItems.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-3 py-4 text-center text-slate-400 text-sm">
                        Aucun remplacement pour {selectedMonthLabel}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function InventoryValuationCard({ valuation }) {
  const pieces = valuation?.pieces
  const serialsByStatus = valuation?.serialsByStatus || []

  const piecesTotal = pieces?.total_value || 0
  const serialsTotal = serialsByStatus.reduce((s, r) => s + (r.total_value || 0), 0)
  const grandTotal = piecesTotal + serialsTotal

  if (!grandTotal) {
    return (
      <div className="flex items-center justify-center h-24 text-slate-300 text-sm">
        Pas encore de données d'inventaire
      </div>
    )
  }

  const rows = [
    {
      key: 'pieces',
      label: 'Pièces',
      sub: `${pieces?.count || 0} produits · valeur unitaire × stock`,
      value: piecesTotal,
      color: 'bg-slate-500',
    },
    ...serialsByStatus.map(s => ({
      key: s.status,
      label: s.status,
      sub: `${s.count} numéro${s.count > 1 ? 's' : ''} de série · valeur à la fabrication`,
      value: s.total_value || 0,
      color: 'bg-brand-500',
    })),
  ]
  const maxVal = Math.max(...rows.map(r => r.value), 1)

  return (
    <div>
      <div className="mb-5 bg-slate-50 rounded-xl p-4">
        <p className="text-xs text-slate-500 mb-1">Cumul total</p>
        <p className="text-2xl font-bold text-slate-900">{fmtCad(grandTotal)}</p>
        <div className="flex gap-3 mt-1 text-xs text-slate-400 flex-wrap">
          <span><span className="inline-block w-2 h-2 rounded-full bg-slate-500 mr-1.5" />Pièces {fmtCad(piecesTotal)}</span>
          <span><span className="inline-block w-2 h-2 rounded-full bg-brand-500 mr-1.5" />Numéros de série {fmtCad(serialsTotal)}</span>
        </div>
      </div>
      <div className="space-y-3">
        {rows.map(r => {
          const width = Math.max((r.value / maxVal) * 100, 0.5)
          const pct = grandTotal ? Math.round((r.value / grandTotal) * 100) : 0
          return (
            <div key={r.key}>
              <div className="flex items-baseline justify-between mb-1 gap-3">
                <div className="min-w-0">
                  <span className="text-sm font-medium text-slate-700">{r.label}</span>
                  <span className="text-xs text-slate-400 ml-2">{r.sub}</span>
                </div>
                <div className="flex items-baseline gap-3 shrink-0">
                  <span className="text-sm tabular-nums font-semibold text-slate-900">{fmtCad(r.value)}</span>
                  <span className="text-xs text-slate-400 tabular-nums w-10 text-right">{pct}%</span>
                </div>
              </div>
              <div className="h-2 bg-slate-100 rounded overflow-hidden">
                <div className={`h-full ${r.color} rounded`} style={{ width: `${width}%` }} />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function fmtCad(n) {
  if (!n) return '$0'
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 }).format(n)
}

// Panel "Mouvements d'abonnements" — affiche, par mois, le nombre de
// nouveaux abonnements / annulations / win-backs et le delta MRR net.
// Chaque ligne se déplie pour montrer la liste des entreprises concernées
// avec montants et liens.
function SubscriptionEventsPanel({ data }) {
  const [openMonth, setOpenMonth] = useState(null)
  if (!data) return <div className="text-slate-400 text-sm">Chargement...</div>
  const months = data.months || []
  if (months.length === 0) {
    return <div className="text-slate-400 text-sm py-4">Aucun mouvement d'abonnement enregistré.</div>
  }
  // Affichage chronologique inverse (mois récent en haut)
  const ordered = [...months].reverse()

  function fmtMonth(m) {
    const [y, mm] = m.split('-')
    return new Date(Number(y), Number(mm) - 1, 1).toLocaleDateString('fr-CA', { month: 'long', year: 'numeric' })
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-xs text-slate-500 uppercase tracking-wide">
            <th className="text-left py-2 pr-4 font-medium">Mois</th>
            <th className="text-right py-2 px-3 font-medium">Net MRR</th>
            <th className="text-right py-2 px-3 font-medium text-emerald-700">Nouveaux</th>
            <th className="text-right py-2 px-3 font-medium text-amber-700">Win-back</th>
            <th className="text-right py-2 px-3 font-medium text-rose-700">Annulations</th>
            <th className="w-6"></th>
          </tr>
        </thead>
        <tbody>
          {ordered.map(m => {
            const isOpen = openMonth === m.month
            const cats = m.categories
            const net = m.net_mrr_delta_cad || 0
            const netCls = net > 0 ? 'text-emerald-700' : net < 0 ? 'text-rose-700' : 'text-slate-500'
            return (
              <Fragment key={m.month}>
                <tr
                  data-testid={`sub-events-month-${m.month}`}
                  className="border-b border-slate-100 hover:bg-slate-50 cursor-pointer"
                  onClick={() => setOpenMonth(isOpen ? null : m.month)}
                >
                  <td className="py-2.5 pr-4 font-medium text-slate-700 capitalize">{fmtMonth(m.month)}</td>
                  <td className={`py-2.5 px-3 text-right font-semibold tabular-nums ${netCls}`}>
                    {net > 0 ? '+' : ''}{fmtCad(Math.abs(net) < 1 ? net : Math.round(net))}
                  </td>
                  <td className="py-2.5 px-3 text-right tabular-nums">
                    <span className="text-emerald-700 font-medium">{cats.new.count}</span>
                    {cats.new.total_amount_cad > 0 && <span className="text-slate-400 text-xs ml-1.5">+{fmtCad(cats.new.total_amount_cad)}</span>}
                  </td>
                  <td className="py-2.5 px-3 text-right tabular-nums">
                    <span className="text-amber-700 font-medium">{cats.winback.count}</span>
                    {cats.winback.total_amount_cad > 0 && <span className="text-slate-400 text-xs ml-1.5">+{fmtCad(cats.winback.total_amount_cad)}</span>}
                  </td>
                  <td className="py-2.5 px-3 text-right tabular-nums">
                    <span className="text-rose-700 font-medium">{cats.churn.count}</span>
                    {cats.churn.total_amount_cad < 0 && <span className="text-slate-400 text-xs ml-1.5">{fmtCad(cats.churn.total_amount_cad)}</span>}
                  </td>
                  <td className="text-slate-400 text-center">{isOpen ? '▾' : '▸'}</td>
                </tr>
                {isOpen && (
                  <tr>
                    <td colSpan={6} className="bg-slate-50 px-4 py-3">
                      <SubscriptionEventsDetail categories={cats} />
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function SubscriptionEventsDetail({ categories }) {
  const sections = [
    { key: 'new', label: 'Nouveaux abonnements', color: 'text-emerald-700' },
    { key: 'winback', label: 'Win-back (rachats après annulation)', color: 'text-amber-700' },
    { key: 'churn', label: 'Annulations', color: 'text-rose-700' },
  ].filter(s => categories[s.key].count > 0)

  if (sections.length === 0) return <div className="text-xs text-slate-400">Aucun mouvement ce mois.</div>

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {sections.map(s => (
        <div key={s.key}>
          <div className={`text-xs font-semibold uppercase tracking-wide mb-1.5 ${s.color}`}>
            {s.label} ({categories[s.key].count})
          </div>
          <ul className="space-y-1">
            {categories[s.key].items.map(it => (
              <li key={it.event_id} className="flex items-center justify-between gap-2 text-xs">
                {it.company_id
                  ? <Link to={`/companies/${it.company_id}`} className="text-brand-600 hover:underline truncate">{it.company_name || '—'}</Link>
                  : <span className="text-slate-400 truncate">— sans client</span>
                }
                <span className="text-slate-500 tabular-nums whitespace-nowrap">
                  {it.amount_cad_delta != null
                    ? (it.amount_cad_delta > 0 ? '+' : '') + fmtCad(it.amount_cad_delta)
                    : '—'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

// ============================================================
// Top Products — best sellers panel (by revenue or quantity)
// ============================================================

function fmtCadCompact(n) {
  if (n == null) return '—'
  if (Math.abs(n) >= 1000) {
    return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 }).format(n)
  }
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD' }).format(n)
}

function fmtNumber(n) {
  return new Intl.NumberFormat('fr-CA').format(n || 0)
}

function dateToYmd(d) { return d.toISOString().slice(0, 10) }
function ymdToDate(s) { return new Date(s + 'T00:00:00Z') }

function DateRangeSlider({ minDate, maxDate, from, to, onChange }) {
  const min = ymdToDate(minDate).getTime()
  const max = ymdToDate(maxDate).getTime()
  const totalDays = Math.max(1, Math.round((max - min) / 86400000))
  const fromDays = Math.max(0, Math.min(totalDays, Math.round((ymdToDate(from).getTime() - min) / 86400000)))
  const toDays   = Math.max(0, Math.min(totalDays, Math.round((ymdToDate(to).getTime()   - min) / 86400000)))
  const lowPct = (fromDays / totalDays) * 100
  const highPct = (toDays / totalDays) * 100
  const daysToYmd = days => dateToYmd(new Date(min + days * 86400000))

  const handleLow = e => {
    const v = Math.min(parseInt(e.target.value), toDays - 1)
    onChange({ from: daysToYmd(v), to })
  }
  const handleHigh = e => {
    const v = Math.max(parseInt(e.target.value), fromDays + 1)
    onChange({ from, to: daysToYmd(v) })
  }

  return (
    <div className="relative h-10 select-none" data-testid="dashboard-top-products-slider">
      <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1.5 bg-slate-200 rounded-full" />
      <div
        className="absolute top-1/2 -translate-y-1/2 h-1.5 bg-brand-500 rounded-full"
        style={{ left: `${lowPct}%`, right: `${100 - highPct}%` }}
      />
      <input
        type="range" min={0} max={totalDays} step={1}
        value={fromDays} onChange={handleLow}
        aria-label="Date de début"
        className="range-slider-thumb absolute inset-0 w-full h-full"
      />
      <input
        type="range" min={0} max={totalDays} step={1}
        value={toDays} onChange={handleHigh}
        aria-label="Date de fin"
        className="range-slider-thumb absolute inset-0 w-full h-full"
      />
    </div>
  )
}

const PRESETS = [
  { id: '30d',  label: '30 j',  days: 30 },
  { id: '90d',  label: '90 j',  days: 90 },
  { id: '6m',   label: '6 mois', days: 182 },
  { id: '1y',   label: '1 an',   days: 365 },
  { id: '2y',   label: '2 ans',  days: 730 },
  { id: 'all',  label: 'Tout',   days: null },
]

function TopProductsPanel() {
  const [range, setRange] = useState({ from: null, to: null, min: null, max: null })
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)
  const [metric, setMetric] = useState('amount') // 'amount' | 'quantity'
  const [topN, setTopN] = useState(15)
  const [activePreset, setActivePreset] = useState('1y')

  // First load: fetch min/max bounds (no filter), then default to last 1 year
  useEffect(() => {
    let alive = true
    api.dashboard.topProducts({}).then(r => {
      if (!alive) return
      const max = r.range?.max_date || dateToYmd(new Date())
      const min = r.range?.min_date || dateToYmd(new Date(Date.now() - 365 * 86400000))
      const oneYearAgo = dateToYmd(new Date(Date.now() - 365 * 86400000))
      const from = oneYearAgo < min ? min : oneYearAgo
      setRange({ from, to: max, min, max })
      // Re-filter for the default 1y window
      api.dashboard.topProducts({ from, to: max }).then(rr => {
        if (!alive) return
        setProducts(rr.products || [])
        setLoading(false)
      })
    }).catch(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [])

  // When range changes, refetch
  useEffect(() => {
    if (!range.from || !range.to) return
    setLoading(true)
    let alive = true
    api.dashboard.topProducts({ from: range.from, to: range.to }).then(r => {
      if (!alive) return
      setProducts(r.products || [])
      setLoading(false)
    }).catch(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [range.from, range.to])

  const applyPreset = id => {
    setActivePreset(id)
    if (id === 'all') {
      setRange(r => ({ ...r, from: r.min, to: r.max }))
      return
    }
    const preset = PRESETS.find(p => p.id === id)
    if (!preset?.days) return
    const to = range.max || dateToYmd(new Date())
    const fromDate = new Date(ymdToDate(to).getTime() - preset.days * 86400000)
    const from = dateToYmd(fromDate)
    const min = range.min
    setRange(r => ({ ...r, from: min && from < min ? min : from, to }))
  }

  const sorted = [...products].sort((a, b) => (
    metric === 'amount' ? (b.amount_cad - a.amount_cad) : (b.quantity - a.quantity)
  ))
  const top = sorted.slice(0, topN)
  const maxValue = top.length ? (metric === 'amount' ? top[0].amount_cad : top[0].quantity) : 0
  const totals = products.reduce((acc, p) => ({
    amount: acc.amount + (p.amount_cad || 0),
    qty: acc.qty + (p.quantity || 0),
  }), { amount: 0, qty: 0 })

  if (!range.from || !range.to) {
    return <div className="h-32 flex items-center justify-center text-slate-400 text-sm">Chargement…</div>
  }

  return (
    <div data-testid="dashboard-top-products">
      {/* Controls row: metric toggle + presets */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="inline-flex rounded-lg border border-slate-200 p-0.5 bg-slate-50">
          <button
            onClick={() => setMetric('amount')}
            className={`px-3 py-1 text-xs rounded-md transition-colors ${metric === 'amount' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
            data-testid="dashboard-top-products-metric-amount"
          >
            Par revenus
          </button>
          <button
            onClick={() => setMetric('quantity')}
            className={`px-3 py-1 text-xs rounded-md transition-colors ${metric === 'quantity' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
            data-testid="dashboard-top-products-metric-quantity"
          >
            Par quantité
          </button>
        </div>

        <div className="inline-flex rounded-lg border border-slate-200 p-0.5 bg-slate-50">
          {PRESETS.map(p => (
            <button
              key={p.id}
              onClick={() => applyPreset(p.id)}
              className={`px-2 py-1 text-xs rounded-md transition-colors ${activePreset === p.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
              data-testid={`dashboard-top-products-preset-${p.id}`}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2 text-xs text-slate-500">
          <label className="text-slate-500">Top</label>
          <select
            value={topN}
            onChange={e => setTopN(parseInt(e.target.value))}
            className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs"
          >
            <option value={5}>5</option>
            <option value={10}>10</option>
            <option value={15}>15</option>
            <option value={25}>25</option>
            <option value={50}>50</option>
          </select>
        </div>
      </div>

      {/* Date range slider */}
      <div className="mb-2">
        <div className="flex items-center justify-between text-xs text-slate-600 mb-1">
          <span className="tabular-nums" data-testid="dashboard-top-products-from">Du {fmtDate(range.from)}</span>
          <span className="tabular-nums" data-testid="dashboard-top-products-to">au {fmtDate(range.to)}</span>
        </div>
        <DateRangeSlider
          minDate={range.min} maxDate={range.max}
          from={range.from} to={range.to}
          onChange={({ from, to }) => { setActivePreset(null); setRange(r => ({ ...r, from, to })) }}
        />
      </div>

      {/* Totals */}
      <div className="text-xs text-slate-500 mb-3">
        {fmtNumber(products.length)} produits sur la période · revenus totaux{' '}
        <span className="font-medium text-slate-700">{fmtCadCompact(totals.amount)}</span>{' '}
        · {fmtNumber(totals.qty)} unités vendues
      </div>

      {/* Bar list */}
      {loading && top.length === 0 ? (
        <div className="h-32 flex items-center justify-center text-slate-400 text-sm">Chargement…</div>
      ) : top.length === 0 ? (
        <div className="h-32 flex items-center justify-center text-slate-400 text-sm">Aucun item vendu sur cette période.</div>
      ) : (
        <ul className="space-y-1.5" data-testid="dashboard-top-products-list">
          {top.map((p, i) => {
            const value = metric === 'amount' ? p.amount_cad : p.quantity
            const pct = maxValue > 0 ? (value / maxValue) * 100 : 0
            const name = p.name_fr || p.name_en || (p.product_id ? '(produit non lié)' : 'Items non liés')
            const Wrapper = p.product_id
              ? ({ children }) => <Link to={`/products/${p.product_id}`} className="block">{children}</Link>
              : ({ children }) => <div>{children}</div>
            return (
              <Wrapper key={p.product_id || `unlinked-${i}`}>
                <li className="group flex items-center gap-3 py-2 px-2 rounded-md hover:bg-slate-50 transition-colors">
                  <span className="text-xs font-mono text-slate-400 w-7 text-right tabular-nums">#{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm text-slate-800 truncate" title={name}>{name}</span>
                      <span className="text-sm font-medium text-slate-900 tabular-nums whitespace-nowrap">
                        {metric === 'amount' ? fmtCadCompact(p.amount_cad) : `${fmtNumber(p.quantity)} u.`}
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                      <div className="h-full bg-brand-500 transition-all" style={{ width: `${pct}%` }} />
                    </div>
                    <div className="mt-0.5 flex justify-between text-[10px] text-slate-400">
                      <span>{p.sku ? `SKU ${p.sku}` : ''}</span>
                      <span>
                        {metric === 'amount'
                          ? `${fmtNumber(p.quantity)} u. · ${p.invoice_count} facture${p.invoice_count > 1 ? 's' : ''}`
                          : `${fmtCadCompact(p.amount_cad)} · ${p.invoice_count} facture${p.invoice_count > 1 ? 's' : ''}`}
                      </span>
                    </div>
                  </div>
                </li>
              </Wrapper>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function fmtDateShort(d) {
  return fmtDate(d, { year: undefined })
}

export default function Dashboard() {
  const [data, setData] = useState(null)
  const [stripeRevenue, setStripeRevenue] = useState(null)
  const [subscriptionEvents, setSubscriptionEvents] = useState(null)
  const [loading, setLoading] = useState(true)
  const [showEditor, setShowEditor] = useState(false)
  const [showGoalEditor, setShowGoalEditor] = useState(false)
  const { user } = useAuth()
  const navigate = useNavigate()
  const [prefs, setPrefs] = useState(() => loadPrefs(user?.id || 'default'))

  const refresh = () => {
    setLoading(true)
    api.dashboard.get().then(setData).catch(console.error).finally(() => setLoading(false))
    api.dashboard.stripeRevenue().then(setStripeRevenue).catch(console.error)
    api.dashboard.subscriptionEvents({ months: 12 }).then(setSubscriptionEvents).catch(console.error)
  }

  useEffect(() => {
    refresh()
  }, [])

  function updatePrefs(newPrefs) {
    setPrefs(newPrefs)
    savePrefs(user?.id || 'default', newPrefs)
  }

  const show = (id) => prefs[id] !== false

  if (loading && !data) {
    return (
      <Layout>
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-brand-600" />
        </div>
      </Layout>
    )
  }

  return (
    <Layout>
      <div className="p-6 max-w-7xl mx-auto">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Tableau de bord</h1>
            <p className="text-slate-500 text-sm mt-1">Vue d'ensemble de votre activité</p>
          </div>
          <button
            onClick={() => setShowEditor(v => !v)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm transition-colors ${showEditor ? 'bg-brand-50 text-brand-700 border border-brand-200' : 'border border-slate-200 text-slate-600 hover:bg-slate-50'}`}
          >
            <SlidersHorizontal size={14} /> Personnaliser
          </button>
        </div>

        {showEditor && (
          <DashboardEditor prefs={prefs} onChange={updatePrefs} onClose={() => setShowEditor(false)} />
        )}

        {/* Project Goal */}
        {show('section_project_goal') && (
          <div className="card p-5 mb-6">
            <div className="mb-4">
              <h2 className="font-semibold text-slate-900">Objectif d'acquisition de projets</h2>
              <p className="text-xs text-slate-400 mt-0.5">Nombre de projets créés entre le {fmtDate(data?.projectGoal?.start_date)} et le {fmtDate(data?.projectGoal?.end_date)}</p>
            </div>
            <ProjectGoalWidget goal={data?.projectGoal} onEdit={() => setShowGoalEditor(true)} />
          </div>
        )}

        {/* Profitability */}
        {show('section_profitability') && (
          <div className="card p-5 mb-6">
            <div className="mb-4">
              <h2 className="font-semibold text-slate-900">Rentabilité des commandes</h2>
              <p className="text-xs text-slate-400 mt-0.5">Items facturables envoyés — 16 dernières semaines · Rolling 28 jours</p>
            </div>
            <ProfitabilityChart data={data?.weeklyProfitability} recentOrders={data?.recentShippedOrders} />
          </div>
        )}

        {/* Ventes et abonnements — last 12 months */}
        {show('section_stripe_revenue') && (
          <div className="card p-5 mb-6">
            <div className="mb-4">
              <h2 className="font-semibold text-slate-900">Ventes et abonnements</h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Encaissements Stripe sur les 12 derniers mois — abonnements vs ventes ponctuelles ·
                remboursements déduits · USD converti au taux BoC du jour du document ·
                taxes exclues · comparé au mois équivalent l'année précédente
              </p>
            </div>
            <StripeRevenueChart
              data={stripeRevenue?.byMonth}
              onMonthClick={(month, type) => navigate(`/factures?month=${month}&type=${type}`)}
            />
          </div>
        )}

        {/* Mouvements d'abonnements */}
        {show('section_subscription_events') && (
          <div className="card p-5 mb-6" data-testid="section-subscription-events">
            <div className="mb-4">
              <h2 className="font-semibold text-slate-900">Mouvements d'abonnements</h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Nouveaux abonnements, win-back (rachats après annulation), annulations et delta MRR net par mois — 12 derniers mois.
                Cliquer sur une ligne pour voir les entreprises concernées.
              </p>
            </div>
            <SubscriptionEventsPanel data={subscriptionEvents} />
          </div>
        )}

        {/* Top products — best sellers */}
        {show('section_top_products') && (
          <div className="card p-5 mb-6" data-testid="section-top-products">
            <div className="mb-4 flex items-center gap-2">
              <Trophy size={18} className="text-amber-500" />
              <div>
                <h2 className="font-semibold text-slate-900">Meilleurs vendeurs</h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Items vendus sur factures Stripe payées · classement par revenus (CAD) ou quantité ·
                  USD converti au taux BoC du jour
                </p>
              </div>
            </div>
            <TopProductsPanel />
          </div>
        )}

        {/* Replacement rate */}
        {show('section_replacement_rate') && (
          <div className="card p-5 mb-6">
            <div className="mb-4">
              <h2 className="font-semibold text-slate-900">Taux de remplacement</h2>
              <p className="text-xs text-slate-400 mt-0.5">Coût des pièces de remplacement envoyées — 12 derniers mois · Rolling 28 jours</p>
            </div>
            <ReplacementRateChart replacementRate={data?.replacementRate} />
          </div>
        )}

        {/* Projects created per month — YoY comparison */}
        {show('section_projects_created') && (
          <div className="card p-5 mb-6">
            <div className="mb-4">
              <h2 className="font-semibold text-slate-900">Projets créés par mois</h2>
              <p className="text-xs text-slate-400 mt-0.5">Nombre de projets créés chaque mois — {new Date().getFullYear()} vs {new Date().getFullYear() - 1}</p>
            </div>
            <ProjectsCreatedChart
              data={data?.projectsCreatedByMonth}
              onMonthClick={month => navigate(`/pipeline?createdMonth=${month}`)}
            />
          </div>
        )}

        {/* Inventory valuation */}
        {show('section_inventory_valuation') && (
          <div className="card p-5 mb-6">
            <div className="mb-4">
              <h2 className="font-semibold text-slate-900">Valeur de l'inventaire</h2>
              <p className="text-xs text-slate-400 mt-0.5">Pièces en stock (valeur unitaire) + numéros de série en inventaire (valeur de fabrication) par statut</p>
            </div>
            <InventoryValuationCard valuation={data?.inventory?.valuation} />
          </div>
        )}

        {/* Closing rate chart */}
        {show('section_closing') && (
          <div className="card p-5 mb-6">
            <div className="mb-4">
              <h2 className="font-semibold text-slate-900">Taux de closing</h2>
              <p className="text-xs text-slate-400 mt-0.5">Projets gagnés / (gagnés + perdus) par mois — 12 derniers mois · Cliquer sur un mois pour voir les projets</p>
            </div>
            <ClosingRateChart data={data?.closingByMonth} onMonthClick={month => navigate(`/pipeline?month=${month}`)} />
          </div>
        )}

        {/* Shipments weekly chart */}
        {show('section_shipments') && (
          <div className="card p-5 mb-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="font-semibold text-slate-900">Livraisons par semaine</h2>
                <p className="text-xs text-slate-400 mt-0.5">Colis envoyés — 16 dernières semaines</p>
              </div>
              <Link to="/envois" className="text-brand-600 text-sm flex items-center gap-1 hover:underline">
                Voir tous <ArrowRight size={14} />
              </Link>
            </div>
            <ShipmentsWeeklyChart data={data?.weeklyShipments} />
          </div>
        )}

        {/* Shipping costs */}
        {show('section_shipping_costs') && (
          <div className="card p-5 mb-6">
            <div className="mb-4">
              <h2 className="font-semibold text-slate-900">Coûts d'expédition</h2>
              <p className="text-xs text-slate-400 mt-0.5">Compte 65000 « Expédition, livraison et poste » — somme des 28 jours précédant chaque lundi</p>
            </div>
            <ShippingCostChart data={data?.weeklyShippingCosts} />
          </div>
        )}

        {/* Geo clients map */}
        {show('section_geo_map') && (
          <div className="card p-5 mb-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="font-semibold text-slate-900">Clients par région</h2>
                <p className="text-xs text-slate-400 mt-0.5">Basé sur la première adresse de livraison — cliquer pour filtrer</p>
              </div>
            </div>
            <GeoClientsMap geoData={data?.geoClients || []} unplacedCount={data?.geoClientsUnplaced || 0} />
          </div>
        )}

        {/* Support weekly quality table */}
        {show('section_support_weekly') && (
          <div className="card p-5 mb-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="font-semibold text-slate-900">Amélioration du support</h2>
                <p className="text-xs text-slate-400 mt-0.5">Indicateurs par semaine — 16 dernières semaines</p>
              </div>
              <Link to="/tickets" className="text-brand-600 text-sm flex items-center gap-1 hover:underline">
                Voir tickets <ArrowRight size={14} />
              </Link>
            </div>
            <SupportWeeklyTable data={data?.weeklySupportStats} />
          </div>
        )}

        <GoalEditorModal
          isOpen={showGoalEditor}
          onClose={() => setShowGoalEditor(false)}
          onSave={refresh}
        />
      </div>
    </Layout>
  )
}
