import { hasRole } from '../../../shared/roles.mjs'
import { useState, useEffect, useRef, Fragment } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowRight, SlidersHorizontal, X, Check, Target, GripVertical, ChevronDown, EyeOff } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { PageTitle } from '../components/PageTitle.jsx'
import Spinner from '../components/Spinner.jsx'
import { useAuth } from '../lib/auth.jsx'
import { fmtDate } from '../lib/formatDate.js'
import { Modal } from '../components/Modal.jsx'
import { AbonnementEventsTable } from '../components/AbonnementEventsTable.jsx'
import { ResizeHandle } from '../components/ResizeHandle.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { DashboardOverview } from '../components/DashboardOverview.jsx'
import { useRealtimeChannel } from '../lib/useRealtimeChannel.js'
import { fmtMoney as fmtMoneyBase, fmtNumber as fmtNumberBase } from '../utils/formatters.js'

// Onglet « Vue globale » — la planche dense façon Power BI. Ce n'est pas une
// section du dashboard (pas dans WIDGET_DEFS) : c'est une seconde lecture des
// mêmes données, adressée par /dashboard/vue-globale.
const OVERVIEW_SLUG = 'vue-globale'

const WIDGET_DEFS = [
  { id: 'section_project_goal',     label: 'Objectif de projets',      group: 'Objectifs',     slug: 'objectif-de-projets' },
  { id: 'section_subscription_events', label: 'Mouvements d\'abonnements', group: 'Graphiques', slug: 'mouvements-abonnements' },
  { id: 'section_profitability',    label: 'Rentabilité',              group: 'Graphiques',    slug: 'rentabilite' },
  { id: 'section_replacement_rate', label: 'Taux de remplacement',     group: 'Graphiques',    slug: 'taux-de-remplacement' },
  { id: 'section_projects_created', label: 'Projets créés par mois',   group: 'Graphiques',    slug: 'projets-crees' },
  { id: 'section_closing',       label: 'Taux de closing',       group: 'Graphiques',    slug: 'taux-de-closing' },
  { id: 'section_shipments',     label: 'Livraisons par semaine', group: 'Graphiques',    slug: 'livraisons' },
  { id: 'section_productivity',  label: 'Productivité',           group: 'Opérations',    slug: 'productivite' },
  { id: 'section_inventory_valuation', label: 'Valeur de l\'inventaire', group: 'Inventaire', slug: 'valeur-inventaire' },
  // « Billets par mois » et « Billets par semaine » : retirés avec la date, le
  // statut et la durée d'un billet (migration 040).
]

// Normalise un slug pour un matching tolérant : minuscules + suppression de
// tout ce qui n'est pas alphanumérique. Ainsi « taux-de-remplacement »,
// « tauxderemplacement » et « tauxDeRemplacement » résolvent vers la même section.
function normalizeSlug(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '')
}

// Résout un slug d'URL (ex: 'tauxderemplacement') vers un id de section
// (ex: 'section_replacement_rate'). Accepte aussi directement l'id complet.
function resolveSectionSlug(slug) {
  if (!slug) return null
  const norm = normalizeSlug(slug)
  const def = WIDGET_DEFS.find(w => normalizeSlug(w.slug) === norm || normalizeSlug(w.id) === norm)
  return def ? def.id : null
}

const DEFAULT_PREFS = Object.fromEntries(WIDGET_DEFS.map(w => [w.id, true]))
const WIDGET_LABEL = Object.fromEntries(WIDGET_DEFS.map(w => [w.id, w.label]))
const WIDGET_SLUG = Object.fromEntries(WIDGET_DEFS.map(w => [w.id, w.slug]))

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

function loadCollapsed(userId) {
  try {
    const raw = localStorage.getItem(`dashboard_collapsed_${userId}`)
    if (raw) return JSON.parse(raw) || {}
  } catch {}
  return {}
}

function saveCollapsed(userId, collapsed) {
  localStorage.setItem(`dashboard_collapsed_${userId}`, JSON.stringify(collapsed))
}

function CollapsibleCard({ id, title, description, leadingIcon, action, collapsed, onToggle, onHide, testId, highlighted, children }) {
  const wrapperProps = {
    'data-section-id': id,
    className: `card p-5 ${collapsed ? 'mb-3' : 'mb-6'} transition-shadow ${highlighted ? 'ring-2 ring-brand-400 ring-offset-2' : ''}`,
  }
  if (testId) wrapperProps['data-testid'] = testId
  return (
    <div {...wrapperProps}>
      <div className={`flex items-start gap-2 ${collapsed ? '' : 'mb-4'}`}>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Déplier la section' : 'Replier la section'}
          data-testid={`section-toggle-${id}`}
          className="text-slate-400 hover:text-slate-700 hover:bg-slate-50 rounded p-0.5 -ml-1 mt-0.5 shrink-0 transition-colors"
        >
          <ChevronDown size={16} className={`transition-transform ${collapsed ? '-rotate-90' : ''}`} />
        </button>
        {leadingIcon ? <div className="shrink-0 mt-0.5">{leadingIcon}</div> : null}
        <div className="flex-1 min-w-0">
          <h2 className="font-semibold text-slate-900">{title}</h2>
          {description && <p className="text-xs text-slate-400 mt-0.5">{description}</p>}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
        {onHide && (
          <button
            type="button"
            onClick={onHide}
            aria-label="Masquer cette section du tableau de bord"
            title="Masquer du tableau de bord"
            data-testid={`section-hide-${id}`}
            className="text-slate-300 hover:text-slate-600 hover:bg-slate-50 rounded p-0.5 mt-0.5 shrink-0 transition-colors"
          >
            <EyeOff size={15} />
          </button>
        )}
      </div>
      {!collapsed && children}
    </div>
  )
}

// Résout l'ordre d'affichage des sections : on part de l'ordre persisté
// dans `prefs._order` (s'il existe), on filtre les ids inconnus, puis on
// complète avec les widgets restants dans l'ordre canonique de WIDGET_DEFS
// (pour que les widgets nouvellement ajoutés au code apparaissent à la fin
// sans qu'on ait besoin de migrer les prefs des utilisateurs existants).
function getOrderedIds(prefs) {
  const allIds = WIDGET_DEFS.map(w => w.id)
  const saved = Array.isArray(prefs?._order) ? prefs._order : []
  const seen = new Set()
  const result = []
  for (const id of saved) {
    if (allIds.includes(id) && !seen.has(id)) { result.push(id); seen.add(id) }
  }
  for (const id of allIds) {
    if (!seen.has(id)) { result.push(id); seen.add(id) }
  }
  return result
}

function DashboardEditor({ prefs, onChange, onClose }) {
  const orderedIds = getOrderedIds(prefs)
  const widgetById = Object.fromEntries(WIDGET_DEFS.map(w => [w.id, w]))
  const dragIdRef = useRef(null)
  const [dragOverId, setDragOverId] = useState(null)
  const [dragOverSide, setDragOverSide] = useState(null)

  function handleDragStart(e, id) {
    dragIdRef.current = id
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move'
      try { e.dataTransfer.setData('text/plain', id) } catch {}
    }
  }
  function handleDragOver(e, id) {
    if (!dragIdRef.current) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    const rect = e.currentTarget.getBoundingClientRect()
    const side = (e.clientY - rect.top) < rect.height / 2 ? 'before' : 'after'
    if (dragOverId !== id) setDragOverId(id)
    if (dragOverSide !== side) setDragOverSide(side)
  }
  function handleDrop(e, targetId) {
    e.preventDefault()
    const sourceId = dragIdRef.current
    // Recalcule le côté ici plutôt que de dépendre de l'état (React batch les
    // setState de handleDragOver, donc dragOverSide peut être stale au moment
    // du drop — surtout si le drag a été simulé synchroniquement par un test).
    const rect = e.currentTarget.getBoundingClientRect()
    const side = (e.clientY - rect.top) < rect.height / 2 ? 'before' : 'after'
    dragIdRef.current = null
    setDragOverId(null)
    setDragOverSide(null)
    if (!sourceId || !targetId || sourceId === targetId) return
    const next = orderedIds.filter(id => id !== sourceId)
    let idx = next.indexOf(targetId)
    if (idx === -1) return
    if (side === 'after') idx += 1
    next.splice(idx, 0, sourceId)
    onChange({ ...prefs, _order: next })
  }
  function handleDragEnd() {
    dragIdRef.current = null
    setDragOverId(null)
    setDragOverSide(null)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-end p-4 pt-16 pointer-events-none">
      <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-80 pointer-events-auto">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
          <h3 className="font-semibold text-slate-900 text-sm">Personnaliser le dashboard</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 p-1 rounded"><X size={14} /></button>
        </div>
        <div className="px-4 py-2 border-b border-slate-100">
          <p className="text-[11px] text-slate-400">Glisser pour réordonner · cocher pour afficher</p>
        </div>
        <div className="p-2 max-h-[70vh] overflow-y-auto" onDragEnd={handleDragEnd}>
          <div className="space-y-0.5">
            {orderedIds.map(id => {
              const w = widgetById[id]
              if (!w) return null
              const isDragOver = dragOverId === id && dragIdRef.current && dragIdRef.current !== id
              return (
                <div
                  key={id}
                  data-testid={`dashboard-editor-row-${id}`}
                  draggable
                  onDragStart={e => handleDragStart(e, id)}
                  onDragOver={e => handleDragOver(e, id)}
                  onDrop={e => handleDrop(e, id)}
                  className="relative flex items-center gap-2 px-2 py-1.5 rounded hover:bg-slate-50 cursor-move"
                >
                  {isDragOver && (
                    <span className={`absolute left-1 right-1 h-0.5 bg-brand-500 pointer-events-none ${dragOverSide === 'before' ? 'top-0' : 'bottom-0'}`} />
                  )}
                  <GripVertical size={12} className="text-slate-300 shrink-0" />
                  <input
                    type="checkbox"
                    checked={prefs[id] !== false}
                    onChange={e => onChange({ ...prefs, [id]: e.target.checked })}
                    onClick={e => e.stopPropagation()}
                    className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                  />
                  <span className="text-sm text-slate-700 truncate flex-1">{w.label}</span>
                  <span className="text-[10px] text-slate-400 shrink-0 uppercase tracking-wide">{w.group}</span>
                </div>
              )
            })}
          </div>
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
  const isAdmin = hasRole(user, 'admin')

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
  const { addToast } = useToast()
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
      addToast({ message: err.message, type: 'error' })
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
              <text x={cx} y={H - 4} textAnchor="middle" fontSize="9" className={m.idx === currentMonthIdx ? 'fill-slate-900' : 'fill-slate-400'} fontWeight={m.idx === currentMonthIdx ? '600' : 'normal'}>{m.label}</text>
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
        Pas encore de données (champ « Vendu » non renseigné)
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

function ShipmentsWeeklyChart({ data, costs }) {
  const navigate = useNavigate()
  const [tooltip, setTooltip] = useState(null)

  if (!data?.length && !costs?.length) {
    return (
      <div className="flex items-center justify-center h-40 text-slate-300 text-sm">
        Pas encore de données d'envois
      </div>
    )
  }

  // 16 dernières semaines (toutes, même vides) : colis + coût d'expédition
  const weeks = []
  for (let i = 15; i >= 0; i--) {
    const d = new Date()
    const day = d.getDay()
    const monday = new Date(d)
    monday.setDate(d.getDate() - ((day + 6) % 7) - i * 7)
    monday.setHours(0, 0, 0, 0)
    const key = monday.toISOString().slice(0, 10)
    const count = (data || []).find(r => r.week_start === key)?.count || 0
    const cost = (costs || []).find(r => r.week_start === key)?.amount || 0
    weeks.push({ key, date: monday, count, cost })
  }

  const maxCount = Math.max(...weeks.map(w => w.count), 1)
  const maxCost = Math.max(...weeks.map(w => w.cost), 1)

  const W = 600, H = 160
  const padL = 28, padR = 36, padT = 12, padB = 28
  const chartW = W - padL - padR
  const chartH = H - padT - padB
  const n = weeks.length
  const barW = Math.floor(chartW / n) - 4

  function xCenter(i) { return padL + (i + 0.5) * (chartW / n) }
  function barHeight(count) { return (count / maxCount) * chartH }
  function yCost(v) { return padT + chartH - (v / maxCost) * chartH }

  const fmtK = v => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`
  const gridCounts = [0, Math.round(maxCount / 2), maxCount].filter((v, i, a) => a.indexOf(v) === i)
  const costPath = weeks.map((w, i) => `${i ? 'L' : 'M'}${xCenter(i)},${yCost(w.cost)}`).join(' ')

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
        {[0, maxCost / 2, maxCost].map(v => (
          <text key={v} x={W - padR + 4} y={yCost(v) + 3.5} textAnchor="start" fontSize="9" fill="#d97706">{fmtK(v)}$</text>
        ))}
        {weeks.map((w, i) => {
          const bh = barHeight(w.count)
          const x = xCenter(i) - barW / 2
          const y = padT + chartH - bh
          const isHovered = tooltip?.i === i
          const showLabel = i === 0 || i === n - 1 || w.date.getDate() <= 7
          const label = fmtDate(w.date)
          return (
            <g key={w.key}
              style={{ cursor: w.count > 0 ? 'pointer' : 'default' }}
              onClick={() => w.count > 0 && navigate(`/envois?week=${w.key}`)}
              onMouseEnter={() => setTooltip({ i, x: xCenter(i), y: Math.min(bh > 0 ? y : padT + chartH - 20, yCost(w.cost)), w })}
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
        <path d={costPath} fill="none" stroke="#f59e0b" strokeWidth={2} strokeLinejoin="round" pointerEvents="none" />
        {weeks.map((w, i) => (
          <circle key={w.key} cx={xCenter(i)} cy={yCost(w.cost)} r={tooltip?.i === i ? 3.5 : 2.5} fill="#f59e0b" pointerEvents="none" />
        ))}
        {tooltip && (() => {
          const tx = Math.min(Math.max(tooltip.x, 60), W - 60)
          const ty = Math.max(tooltip.y - 22, padT + 4)
          const label = fmtDate(tooltip.w.date)
          return (
            <g pointerEvents="none">
              <rect x={tx - 48} y={ty - 14} width={96} height={46} rx="5" fill="#1e293b" opacity="0.92" />
              <text x={tx} y={ty + 1} textAnchor="middle" fontSize="11" fontWeight="bold" fill="white">
                {tooltip.w.count} colis
              </text>
              <text x={tx} y={ty + 14} textAnchor="middle" fontSize="11" fontWeight="bold" fill="#fbbf24">
                {fmtCad(tooltip.w.cost)}
              </text>
              <text x={tx} y={ty + 26} textAnchor="middle" fontSize="9" fill="#94a3b8">
                Sem. du {label}
              </text>
            </g>
          )
        })()}
      </svg>
      <div className="flex items-center justify-end gap-3 text-xs text-slate-400 mt-1">
        <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-sm bg-[#21B14B]" />Colis</span>
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-[#f59e0b]" />Coût</span>
      </div>
    </div>
  )
}

// `pct` / `PctCell` sont partis avec « Billets par semaine » (migration 040).

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

  // Chaque point = fenêtre glissante 28 jours (4 semaines) se terminant à cette semaine.
  // On résume les commandes des 28 derniers jours, pas seulement de la semaine.
  const rollingWeeks = weeks.map((w, i) => {
    const window = weeks.slice(Math.max(0, i - 3), i + 1)
    return {
      ...w,
      revenue:       window.reduce((s, x) => s + x.revenue, 0),
      cogs:          window.reduce((s, x) => s + x.cogs, 0),
      subRevenue:    window.reduce((s, x) => s + x.subRevenue, 0),
      subCogs:       window.reduce((s, x) => s + x.subCogs, 0),
      achatRevenue:  window.reduce((s, x) => s + x.achatRevenue, 0),
      achatCogs:     window.reduce((s, x) => s + x.achatCogs, 0),
      windowWeeks:   window.length,
    }
  })

  // 28-day rolling courant = fenêtre du dernier point
  const current28 = rollingWeeks[rollingWeeks.length - 1] || { revenue: 0, cogs: 0, subRevenue: 0, achatRevenue: 0 }
  const rolling28Revenue = current28.revenue
  const rolling28Cogs    = current28.cogs
  const rolling28Margin  = rolling28Revenue - rolling28Cogs
  const rolling28Pct     = rolling28Revenue > 0 ? Math.round((rolling28Margin / rolling28Revenue) * 100) : null

  // Sub vs Achat breakdown for 28j
  const subRevenue28   = current28.subRevenue
  const achatRevenue28 = current28.achatRevenue

  // Compute margin % per point (sur la fenêtre 28 jours)
  const weekMargins = rollingWeeks.map(w => w.revenue > 0 ? Math.round(((w.revenue - w.cogs) / w.revenue) * 100) : null)

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

          {/* Points + hover zones — chaque point résume la fenêtre 28 jours */}
          {rollingWeeks.map((w, i) => {
            if (weekMargins[i] === null) return null
            const cx = xPos(i)
            const cy = yPos(weekMargins[i])
            const isHovered = tooltip?.i === i
            const isSelected = selectedWeek === w.key
            const isLast4 = i >= n - 4
            const showLabel = i === 0 || i === n - 1 || w.date.getDate() <= 7
            const label = fmtDate(w.date)
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
                  <text x={cx} y={H - 4} textAnchor="middle" fontSize="8" fontWeight={isSelected ? 'bold' : 'normal'} className={isSelected ? 'fill-slate-900' : 'fill-slate-400'}>{label}</text>
                )}
              </g>
            )
          })}

          {/* Tooltip */}
          {tooltip && (() => {
            const tx = Math.min(Math.max(tooltip.x, 70), W - 70)
            const ty = Math.max(tooltip.y - 8, padT + 4)
            const w = tooltip.w
            // Fin de la fenêtre 28j = dimanche de la semaine du point
            const endDate = new Date(w.date.getTime() + 6 * 86400000)
            const label = fmtDate(endDate)
            const hasBreakdown = activeFilter === 'Tous' && (w.subRevenue > 0 || w.achatRevenue > 0)
            const tooltipH = hasBreakdown ? 82 : 66
            return (
              <g pointerEvents="none">
                <rect x={tx - 64} y={ty - 14} width={128} height={tooltipH} rx="5" fill="#1e293b" opacity="0.93" />
                <text x={tx} y={ty + 2} textAnchor="middle" fontSize="9" fill="#94a3b8">
                  28j au {label}
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
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block" /> Marge % (28j glissants)</span>
          <span className="ml-auto">Chaque point = 28 jours glissants</span>
        </div>
      </div>

      {/* Shipped orders table — filtered by activeFilter and (optionally) selectedWeek */}
      {recentOrders?.length > 0 && (() => {
        const byType = activeFilter === 'Tous' ? recentOrders
          : activeFilter === 'Abonnement' ? recentOrders.filter(o => o.is_subscription)
          : recentOrders.filter(o => !o.is_subscription)

        // Fenêtre 28 jours se terminant à la semaine sélectionnée (point cliqué)
        let weekStart = null, weekEnd = null, weekLabel = null
        if (selectedWeek) {
          const [yr, mo, dy] = selectedWeek.split('-').map(Number)
          const monday = new Date(yr, mo - 1, dy)
          weekEnd = new Date(monday.getTime() + 7 * 86400000)       // dimanche soir de la semaine du point
          weekStart = new Date(monday.getTime() - 21 * 86400000)    // 28 jours avant la fin de fenêtre
          weekLabel = fmtDate(new Date(monday.getTime() + 6 * 86400000))
        }
        // Point sélectionné → fenêtre 28j de ce point. Sinon → 28 derniers jours
        // (le serveur renvoie 140j pour couvrir tout le graphe, on borne ici l'affichage par défaut).
        const filtered = selectedWeek
          ? byType.filter(o => {
              if (!o.last_shipped_at) return false
              const t = new Date(o.last_shipped_at).getTime()
              return t >= weekStart.getTime() && t < weekEnd.getTime()
            })
          : byType.filter(o => {
              if (!o.last_shipped_at) return false
              return new Date(o.last_shipped_at).getTime() >= Date.now() - 28 * 86400000
            })

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
                  ? `Commandes — 28 jours au ${weekLabel} (${filtered.length})`
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
                          ? `Aucune commande envoyée dans les 28 jours au ${weekLabel}`
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

// Colonnes du tableau détaillé des remplacements : largeur par défaut (px) et
// alignement. Les largeurs sont redimensionnables et mémorisées par utilisateur.
const REPLACEMENT_COLS = [
  { key: 'order',   label: 'Commande',     width: 110, align: 'text-left',
    cellClass: 'text-slate-700 font-mono text-xs', render: it => `#${it.order_number}` },
  { key: 'company', label: 'Client',       width: 200, align: 'text-left',
    cellClass: 'text-slate-700', render: it => it.company_name || '—' },
  { key: 'product', label: 'Produit',      width: 260, align: 'text-left',
    cellClass: 'text-slate-700', render: it => it.product_name || '—' },
  { key: 'qty',     label: 'Qté',          width: 60,  align: 'text-center',
    cellClass: 'text-slate-600', render: it => it.qty },
  // Pas de « Coût unit. » : le champ « Coût unitaire » des articles de commande
  // a été retiré (2026-09-03), le coût d'une ligne se lit à son total.
  { key: 'total',   label: 'Total',        width: 100, align: 'text-right',
    cellClass: 'font-medium text-amber-700', render: it => fmtCad(it.total_cost) },
  { key: 'shipped', label: "Date d'envoi", width: 120, align: 'text-right',
    cellClass: 'text-slate-500', render: it => (it.shipped_at ? fmtDate(it.shipped_at) : '—') },
]
const REPLACEMENT_COL_DEFAULTS = Object.fromEntries(REPLACEMENT_COLS.map(c => [c.key, c.width]))

function loadReplacementColWidths(userId) {
  try {
    const raw = localStorage.getItem(`dashboard_replacement_cols_${userId}`)
    if (raw) return { ...REPLACEMENT_COL_DEFAULTS, ...JSON.parse(raw) }
  } catch {}
  return { ...REPLACEMENT_COL_DEFAULTS }
}

function ReplacementRateChart({ replacementRate }) {
  const navigate = useNavigate()
  const [tooltip, setTooltip] = useState(null)
  const [showItems, setShowItems] = useState(false)
  const [selectedMonth, setSelectedMonth] = useState(null)
  const { user } = useAuth()
  const [colWidths, setColWidths] = useState(() => loadReplacementColWidths(user?.id))
  const { parkValue = 0, last28 = 0, byMonth = [], items = [] } = replacementRate || {}

  // Autosave des largeurs (localStorage, par utilisateur) — pas de bouton.
  function resizeCol(key, w) {
    setColWidths(prev => {
      const next = { ...prev, [key]: Math.round(w) }
      try { localStorage.setItem(`dashboard_replacement_cols_${user?.id}`, JSON.stringify(next)) } catch {}
      return next
    })
  }

  function resetColWidths() {
    setColWidths({ ...REPLACEMENT_COL_DEFAULTS })
    try { localStorage.removeItem(`dashboard_replacement_cols_${user?.id}`) } catch {}
  }

  const colsTotalWidth = REPLACEMENT_COLS.reduce((s, c) => s + (colWidths[c.key] || c.width), 0)
  const colWidthsCustomized = REPLACEMENT_COLS.some(c => (colWidths[c.key] || c.width) !== c.width)

  const filteredItems = selectedMonth
    ? items.filter(it => {
        // Mois de la date affichée (et des barres, calculées côté serveur) :
        // new Date('2026-10-01') = 30 sept. 20h à Montréal → mauvais mois.
        if (!it.shipped_at) return false
        return fmtDate(it.shipped_at).slice(0, 7) === selectedMonth
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
            {showItems && colWidthsCustomized && (
              <button
                data-testid="replacement-cols-reset"
                onClick={resetColWidths}
                className="text-xs text-slate-500 hover:text-slate-700 underline"
              >
                Réinitialiser les largeurs
              </button>
            )}
          </div>
          {showItems && (
            <div className="mt-2 border border-slate-200 rounded-lg overflow-hidden">
              <div className="overflow-x-auto">
                <table
                  className="text-sm"
                  style={{ tableLayout: 'fixed', width: '100%', minWidth: colsTotalWidth }}
                  data-testid="replacement-items-table"
                >
                  <colgroup>
                    {REPLACEMENT_COLS.map(c => (
                      <col key={c.key} style={{ width: colWidths[c.key] || c.width }} />
                    ))}
                    {/* Colonne tampon : absorbe l'espace restant quand la carte
                        est plus large que la somme des colonnes. */}
                    <col />
                  </colgroup>
                  <thead>
                    <tr className="bg-slate-50 text-left text-xs text-slate-500">
                      {REPLACEMENT_COLS.map(c => (
                        <th
                          key={c.key}
                          data-testid={`replacement-col-${c.key}`}
                          className={`relative group/header px-3 py-2 font-medium truncate ${c.align}`}
                        >
                          {c.label}
                          <ResizeHandle onResize={w => resizeCol(c.key, w)} />
                        </th>
                      ))}
                      <th className="p-0" />
                    </tr>
                  </thead>
                  <tbody>
                    {filteredItems.map((it, idx) => (
                      <tr
                        key={idx}
                        // Une ligne = une commande : le clic ouvre la fiche en
                        // panneau latéral (registre recordPeekRoutes).
                        onClick={it.order_id ? () => navigate(`/orders/${it.order_id}`) : undefined}
                        className={`${idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'} ${
                          it.order_id ? 'cursor-pointer hover:bg-blue-50' : ''
                        }`}
                      >
                        {REPLACEMENT_COLS.map(c => {
                          const v = c.render(it)
                          return (
                            <td
                              key={c.key}
                              data-col={c.key}
                              // Colonne rétrécie : l'infobulle native rend la valeur complète lisible.
                              title={typeof v === 'string' ? v : undefined}
                              className={`px-3 py-1.5 truncate ${c.align} ${c.cellClass}`}
                            >
                              {v}
                            </td>
                          )
                        })}
                        <td className="p-0" />
                      </tr>
                    ))}
                    {filteredItems.length === 0 && (
                      <tr>
                        <td colSpan={REPLACEMENT_COLS.length + 1} className="px-3 py-4 text-center text-slate-400 text-sm">
                          Aucun remplacement pour {selectedMonthLabel}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// Pill « Valeur inventaire » de la table products : exactement les pièces sans
// numéro de série, mêmes filtres que le calcul serveur (routes/dashboard.js).
// Si la vue disparaissait, `?vue=` inconnu retombe sur la vue habituelle.
const PIECES_VALUATION_VIEW_ID = '997d024c-a474-4e01-98bb-74a9530d6b41'

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
      sub: `${pieces?.count || 0} produits · valeur FIFO (vue « Valeur inventaire »)`,
      value: piecesTotal,
      color: 'bg-slate-500',
      to: `/products?vue=${PIECES_VALUATION_VIEW_ID}`,
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
          const Row = r.to ? Link : 'div'
          return (
            <Row
              key={r.key}
              {...(r.to ? { to: r.to, title: 'Voir ces pièces dans l\'inventaire', className: 'block group' } : {})}
            >
              <div className="flex items-baseline justify-between mb-1 gap-3">
                <div className="min-w-0">
                  <span className={`text-sm font-medium text-slate-700 ${r.to ? 'group-hover:text-brand-700' : ''}`}>{r.label}</span>
                  <span className="text-xs text-slate-400 ml-2">{r.sub}</span>
                </div>
                <div className="flex items-baseline gap-3 shrink-0">
                  <span className="text-sm tabular-nums font-semibold text-slate-900">{fmtCad(r.value)}</span>
                  <span className="text-xs text-slate-400 tabular-nums w-10 text-right">{pct}%</span>
                </div>
              </div>
              <div className="h-2 bg-slate-100 rounded overflow-hidden">
                <div className={`h-full ${r.color} rounded ${r.to ? 'group-hover:brightness-125' : ''}`} style={{ width: `${width}%` }} />
              </div>
            </Row>
          )
        })}
      </div>
    </div>
  )
}

const fmtCad = (n) => fmtMoneyBase(n, 'CAD', { fallback: '$0', zeroIsEmpty: true, maximumFractionDigits: 0 })

// Panel "Mouvements d'abonnements" — un seul DataTable des events des 12
// derniers mois, avec groupage imbriqué mois → catégorie. Les sommes par
// niveau (Net MRR par mois, puis par catégorie) sont affichées dans les
// en-têtes de groupe via `__sums` calculé par DataTable.
function SubscriptionEventsPanel({ data }) {
  if (!data) return <div className="text-slate-400 text-sm"><Spinner size="xs" label="Chargement…" /></div>
  const months = data.months || []
  if (months.length === 0) {
    return <div className="text-slate-400 text-sm py-4">Aucun mouvement d'abonnement enregistré.</div>
  }

  // Aplatit categories.{creation,upgrade,downgrade,churn}.items[] en une liste
  // unique d'events, en injectant `month` + `category` + `id` (pour DataTable).
  const events = []
  for (const m of months) {
    for (const cat of ['creation', 'upgrade', 'downgrade', 'churn']) {
      for (const item of (m.categories[cat]?.items || [])) {
        events.push({ ...item, id: item.event_id, category: cat, month: m.month })
      }
    }
  }

  return (
    <AbonnementEventsTable
      data={events}
      initialGroupBy={['month', 'category']}
      initialGroupOrder={['desc', 'default']}
      forceAllView
    />
  )
}

function fmtCadCompact(n) {
  if (n == null) return '—'
  return fmtMoneyBase(n, 'CAD', Math.abs(n) >= 1000 ? { maximumFractionDigits: 0 } : {})
}

const fmtNumber = n => fmtNumberBase(n, { nullIsZero: true })

// ============================================================
// Productivité — ventes QuickBooks ÷ heures travaillées aux Opérations
// ============================================================

function fmtMonthLabel(month) {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, 1))
    .toLocaleDateString('fr-CA', { month: 'short', year: '2-digit', timeZone: 'UTC' })
}

function ProductivityPanel() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [scope, setScope] = useState('sales')
  const [months, setMonths] = useState(12)

  const load = (opts = {}) => {
    setLoading(true)
    setError(null)
    api.dashboard.productivity({ months, scope, ...opts })
      .then(r => { setData(r); setLoading(false) })
      .catch(e => { setError(e?.message || 'Erreur'); setLoading(false) })
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [scope, months])

  if (loading && !data) {
    return <div className="h-32 flex items-center justify-center text-slate-400 text-sm"><Spinner size="xs" label="Chargement…" /></div>
  }
  if (error) {
    return (
      <div className="text-sm text-rose-600">
        {error}
        <button onClick={() => load()} className="ml-2 underline">Réessayer</button>
      </div>
    )
  }
  const rows = data?.months || []
  if (!rows.length) return <div className="text-sm text-slate-500">Aucune donnée.</div>

  const maxProd = Math.max(1, ...rows.map(r => Math.abs(r.productivity || 0)))

  return (
    <div data-testid="dashboard-productivity">
      <div className="flex items-center gap-2 mb-3 text-xs">
        <div className="flex rounded-md border border-slate-200 overflow-hidden">
          {[{ id: 'sales', label: 'Ventes' }, { id: 'all', label: 'Tous revenus' }].map(o => (
            <button
              key={o.id}
              onClick={() => setScope(o.id)}
              className={`px-2 py-1 transition-colors ${scope === o.id ? 'bg-brand-50 text-brand-700 font-medium' : 'text-slate-500 hover:bg-slate-50'}`}
            >
              {o.label}
            </button>
          ))}
        </div>
        <div className="flex rounded-md border border-slate-200 overflow-hidden">
          {[12, 24].map(m => (
            <button
              key={m}
              onClick={() => setMonths(m)}
              className={`px-2 py-1 transition-colors ${months === m ? 'bg-brand-50 text-brand-700 font-medium' : 'text-slate-500 hover:bg-slate-50'}`}
            >
              {m} mois
            </button>
          ))}
        </div>
        <button onClick={() => load({ refresh: 1 })} className="ml-auto link-record">Rafraîchir</button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100">
              <th className="px-3 py-2 text-left text-xs font-semibold text-slate-400 uppercase tracking-wide">Mois</th>
              <th className="px-3 py-2 text-right text-xs font-semibold text-slate-400 uppercase tracking-wide">Ventes</th>
              <th className="px-3 py-2 text-right text-xs font-semibold text-slate-400 uppercase tracking-wide">Heures</th>
              <th className="px-3 py-2 text-right text-xs font-semibold text-slate-400 uppercase tracking-wide">$ / h</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {rows.map(r => (
              <tr
                key={r.month}
                className={`hover:bg-slate-50 transition-colors ${r.partial ? 'text-slate-400' : ''}`}
                title={r.partial
                  ? (r.is_current_month ? 'Mois en cours — ventes et heures partielles' : `Paie incomplète — ${r.coverage_pct} % du mois couvert`)
                  : undefined}
              >
                <td className="px-3 py-2 whitespace-nowrap">
                  {fmtMonthLabel(r.month)}
                  {r.partial && <span className="ml-1 text-amber-500">*</span>}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtCadCompact(r.sales)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.hours ? fmtNumber(Math.round(r.hours)) : '—'}</td>
                <td className="px-3 py-2 text-right tabular-nums w-40">
                  <div className="flex items-center justify-end gap-2">
                    <div className="flex-1 h-1.5 bg-slate-100 rounded overflow-hidden">
                      <div
                        className={`h-full rounded ${r.productivity < 0 ? 'bg-rose-400' : r.partial ? 'bg-slate-300' : 'bg-brand-500'}`}
                        style={{ width: `${Math.min(100, Math.abs(r.productivity || 0) / maxProd * 100)}%` }}
                      />
                    </div>
                    <span className={`font-semibold ${r.partial ? '' : 'text-slate-900'}`}>
                      {r.productivity == null ? '—' : fmtCadCompact(r.productivity)}
                    </span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-slate-200 font-semibold text-slate-900">
              <td className="px-3 py-2">Total · {data.totals.months} mois complets</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtCadCompact(data.totals.sales)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtNumber(Math.round(data.totals.hours))}</td>
              <td className="px-3 py-2 text-right tabular-nums">{data.totals.productivity == null ? '—' : fmtCadCompact(data.totals.productivity)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="mt-2 px-3 text-xs text-slate-400">
        <span className="text-amber-500">*</span> mois incomplet, exclu du total
      </div>
    </div>
  )
}

function fmtDateShort(d) {
  return fmtDate(d, { year: undefined })
}

export default function Dashboard() {
  const [data, setData] = useState(null)
  const [subscriptionEvents, setSubscriptionEvents] = useState(null)
  const [loading, setLoading] = useState(true)
  const [showEditor, setShowEditor] = useState(false)
  const [showGoalEditor, setShowGoalEditor] = useState(false)
  const { user } = useAuth()
  const { addToast } = useToast()
  const navigate = useNavigate()
  const { section: sectionParam } = useParams()
  const [prefs, setPrefs] = useState(() => loadPrefs(user?.id || 'default'))
  const [collapsed, setCollapsed] = useState(() => loadCollapsed(user?.id || 'default'))
  const [highlightId, setHighlightId] = useState(null)
  const [activeId, setActiveId] = useState(null)
  const isOverview = normalizeSlug(sectionParam) === normalizeSlug(OVERVIEW_SLUG)

  const refresh = () => {
    setLoading(true)
    api.dashboard.get().then(setData).catch(console.error).finally(() => setLoading(false))
    api.dashboard.subscriptionEvents({ months: 12 }).then(setSubscriptionEvents).catch(console.error)
  }

  useEffect(() => {
    refresh()
  }, [])

  // Entreprise d'un mouvement corrigée (fiche abonnement, collègue) → panneau.
  useRealtimeChannel('subscription_events:list', (msg) => {
    if (msg.type !== 'subscription_event:updated') return
    const { id, company_id, company_name } = msg.payload
    setSubscriptionEvents(prev => prev && {
      ...prev,
      months: prev.months.map(m => ({
        ...m,
        categories: Object.fromEntries(Object.entries(m.categories).map(([cat, c]) => [cat, {
          ...c,
          items: c.items?.map(it => it.event_id === id ? { ...it, company_id, company_name } : it),
        }])),
      })),
    })
  })

  // Scrolle vers une section, la déplie si repliée, et la met en surbrillance
  // brièvement. Réutilisé par le deep-link (URL) et la table des matières.
  function scrollToSection(targetId) {
    if (!targetId) return
    if (collapsed[targetId]) {
      setCollapsed(prev => ({ ...prev, [targetId]: false }))
    }
    setTimeout(() => {
      const el = document.querySelector(`[data-section-id="${targetId}"]`)
      if (el) {
        // Animation seulement quand la cible est proche : un défilement doux de
        // plusieurs milliers de pixels donne un long survol de tout le
        // dashboard. Au-delà de ~1,5 écran, on saute directement.
        const distance = Math.abs(el.getBoundingClientRect().top)
        const near = distance < window.innerHeight * 1.5
        el.scrollIntoView({ behavior: near ? 'smooth' : 'auto', block: 'start' })
        setHighlightId(targetId)
        setTimeout(() => setHighlightId(null), 2000)
      }
    }, 100)
  }

  // Deep-link vers une section : /dashboard/:section (ex: /dashboard/taux-de-remplacement).
  // On attend que les données soient chargées (sections rendues) avant de scroller.
  useEffect(() => {
    const targetId = resolveSectionSlug(sectionParam)
    if (!targetId || loading) return
    scrollToSection(targetId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionParam, loading])

  function updatePrefs(newPrefs) {
    setPrefs(newPrefs)
    savePrefs(user?.id || 'default', newPrefs)
  }

  // Change une seule pref de visibilité en fonctionnel (évite les closures
  // périmées si l'utilisateur masque/restaure plusieurs fiches rapidement).
  function setPrefVisible(id, visible) {
    setPrefs(prev => {
      const next = { ...prev, [id]: visible }
      savePrefs(user?.id || 'default', next)
      return next
    })
  }

  function hideSection(id) {
    setPrefVisible(id, false)
    addToast({
      message: `« ${WIDGET_LABEL[id]} » masquée du dashboard`,
      action: { label: 'Annuler', onClick: () => setPrefVisible(id, true) },
    })
  }

  function toggleCollapsed(id) {
    setCollapsed(prev => {
      const next = { ...prev, [id]: !prev[id] }
      saveCollapsed(user?.id || 'default', next)
      return next
    })
  }

  const show = (id) => prefs[id] !== false
  const isCollapsed = (id) => collapsed[id] === true
  const orderedIds = getOrderedIds(prefs)
  // Sections effectivement affichées (visibles via prefs), dans l'ordre courant.
  const visibleIds = orderedIds.filter(show)
  const visibleKey = visibleIds.join(',')

  // Scroll-spy : surligne dans la table des matières la section actuellement
  // en haut du viewport. IntersectionObserver avec une bande de détection en
  // haut du conteneur de scroll (<main>).
  useEffect(() => {
    if (loading) return
    const ids = visibleKey ? visibleKey.split(',') : []
    if (!ids.length) return
    const visible = new Set()
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const id = e.target.getAttribute('data-section-id')
        if (e.isIntersecting) visible.add(id)
        else visible.delete(id)
      }
      const first = ids.find(id => visible.has(id))
      if (first) setActiveId(first)
    }, { rootMargin: '-72px 0px -65% 0px', threshold: 0 })
    ids.forEach(id => {
      const el = document.querySelector(`[data-section-id="${id}"]`)
      if (el) io.observe(el)
    })
    return () => io.disconnect()
  }, [loading, visibleKey])

  // Map id → JSX. L'ordre d'affichage est piloté par `orderedIds`, pas par
  // l'ordre déclaré ici — quand tu ajoutes une nouvelle section, ajoute-la
  // aussi à WIDGET_DEFS pour qu'elle apparaisse dans le panneau de
  // personnalisation et soit ordonnable.
  const cardProps = (id, extra = {}) => ({
    id,
    collapsed: isCollapsed(id),
    onToggle: () => toggleCollapsed(id),
    onHide: () => hideSection(id),
    highlighted: highlightId === id,
    ...extra,
  })

  const cards = {
    section_project_goal: (
      <CollapsibleCard
        {...cardProps('section_project_goal')}
        title="Objectif d'acquisition de projets"
        description={`Nombre de projets créés entre le ${fmtDate(data?.projectGoal?.start_date)} et le ${fmtDate(data?.projectGoal?.end_date)}`}
      >
        <ProjectGoalWidget goal={data?.projectGoal} onEdit={() => setShowGoalEditor(true)} />
      </CollapsibleCard>
    ),
    section_profitability: (
      <CollapsibleCard
        {...cardProps('section_profitability')}
        title="Rentabilité des commandes"
        description="Items facturables envoyés — 16 dernières semaines · Rolling 28 jours"
      >
        <ProfitabilityChart data={data?.weeklyProfitability} recentOrders={data?.recentShippedOrders} />
      </CollapsibleCard>
    ),
    section_subscription_events: (
      <CollapsibleCard
        {...cardProps('section_subscription_events', { testId: 'section-subscription-events' })}
        title="Mouvements d'abonnements"
        description="Nouveaux abonnements, win-back (rachats après annulation), annulations et delta MRR net par mois — 12 derniers mois. Cliquer sur une ligne pour voir les entreprises concernées."
      >
        <SubscriptionEventsPanel data={subscriptionEvents} />
      </CollapsibleCard>
    ),
    section_replacement_rate: (
      <CollapsibleCard
        {...cardProps('section_replacement_rate')}
        title="Taux de remplacement"
        description="Coût des pièces de remplacement envoyées — 12 derniers mois · Rolling 28 jours"
      >
        <ReplacementRateChart replacementRate={data?.replacementRate} />
      </CollapsibleCard>
    ),
    section_projects_created: (
      <CollapsibleCard
        {...cardProps('section_projects_created')}
        title="Projets créés par mois"
        description={`Nombre de projets créés chaque mois — ${new Date().getFullYear()} vs ${new Date().getFullYear() - 1}`}
      >
        <ProjectsCreatedChart
          data={data?.projectsCreatedByMonth}
          onMonthClick={month => navigate(`/pipeline?createdMonth=${month}`)}
        />
      </CollapsibleCard>
    ),
    section_productivity: (
      <CollapsibleCard
        {...cardProps('section_productivity', { testId: 'section-productivity' })}
        title="Productivité"
        description="Ventes du mois (QuickBooks) ÷ heures travaillées par les Opérations (paies, réparties au prorata des jours de chaque période)"
      >
        <ProductivityPanel />
      </CollapsibleCard>
    ),
    section_inventory_valuation: (
      <CollapsibleCard
        {...cardProps('section_inventory_valuation')}
        title="Valeur de l'inventaire"
        description="Pièces en stock + numéros de série par statut, hors vendus et loués (en service chez le client)"
      >
        <InventoryValuationCard valuation={data?.inventory?.valuation} />
      </CollapsibleCard>
    ),
    section_closing: (
      <CollapsibleCard
        {...cardProps('section_closing')}
        title="Taux de closing"
        description="Projets vendus / (vendus + non vendus) par mois — 12 derniers mois · Cliquer sur un mois pour voir les projets"
      >
        <ClosingRateChart data={data?.closingByMonth} onMonthClick={month => navigate(`/pipeline?month=${month}`)} />
      </CollapsibleCard>
    ),
    section_shipments: (
      <CollapsibleCard
        {...cardProps('section_shipments')}
        title="Livraisons par semaine"
        description="Colis envoyés et coût d'expédition (compte 65000) — 16 dernières semaines"
        action={
          <Link to="/envois" className="text-brand-600 text-sm flex items-center gap-1 hover:underline">
            Voir tous <ArrowRight size={14} />
          </Link>
        }
      >
        <ShipmentsWeeklyChart data={data?.weeklyShipments} costs={data?.weeklyShippingCostsByWeek} />
      </CollapsibleCard>
    ),
  }

  if (loading && !data) {
    return (
      <Layout>
        <Spinner center />
      </Layout>
    )
  }

  return (
    <Layout>
      <div className={`p-6 mx-auto ${isOverview ? 'max-w-[1700px]' : 'max-w-7xl'}`}>
        <div className="mb-4 flex items-center justify-between">
          <div>
            <PageTitle>Tableau de bord</PageTitle>
            <p className="text-slate-500 text-sm mt-1">
              {isOverview ? 'Toute l\'activité sur une seule planche' : 'Vue d\'ensemble de votre activité'}
            </p>
          </div>
          {!isOverview && (
            <button
              onClick={() => setShowEditor(v => !v)}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm transition-colors ${showEditor ? 'bg-brand-50 text-brand-700 border border-brand-200' : 'border border-slate-200 text-slate-600 hover:bg-slate-50'}`}
            >
              <SlidersHorizontal size={14} /> Personnaliser
            </button>
          )}
        </div>

        {/* Deux lectures des mêmes données : les sections dépliables (par
            défaut) et la planche dense « Vue globale ». */}
        <div className="mb-5 flex items-center gap-1 border-b border-slate-200" role="tablist" data-testid="dashboard-tabs">
          {[
            { to: `/dashboard/${OVERVIEW_SLUG}`, label: 'Vue globale', active: isOverview, testId: 'dashboard-tab-overview' },
            { to: '/dashboard', label: 'Sections', active: !isOverview, testId: 'dashboard-tab-sections' },
          ].map(t => (
            <Link
              key={t.to}
              to={t.to}
              role="tab"
              aria-selected={t.active}
              data-testid={t.testId}
              className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
                t.active
                  ? 'border-brand-500 font-medium text-brand-700'
                  : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800'
              }`}
            >
              {t.label}
            </Link>
          ))}
        </div>

        {isOverview ? (
          <DashboardOverview data={data} subscriptionEvents={subscriptionEvents} />
        ) : (
        <>
        {showEditor && (
          <DashboardEditor prefs={prefs} onChange={updatePrefs} onClose={() => setShowEditor(false)} />
        )}

        <div className="flex gap-6 items-start">
          {/* Table des matières — sticky, masquée sous lg. Reflète l'ordre et la
              visibilité courants des sections. Cliquer scrolle vers la section. */}
          <nav
            aria-label="Sections du tableau de bord"
            className="hidden lg:block w-56 shrink-0 sticky top-6 self-start max-h-[calc(100vh-6rem)] overflow-y-auto"
            data-testid="dashboard-toc"
          >
            <div className="text-xs font-semibold text-slate-400 uppercase tracking-wide px-3 mb-1">Sections</div>
            <ul className="space-y-0.5">
              {visibleIds.map(id => {
                const isActive = activeId === id
                return (
                  <li key={id}>
                    <Link
                      to={`/dashboard/${WIDGET_SLUG[id]}`}
                      data-testid={`toc-link-${id}`}
                      data-active={isActive ? 'true' : 'false'}
                      className={`block text-sm px-3 py-1.5 rounded-md border-l-2 transition-colors truncate ${
                        isActive
                          ? 'border-brand-500 bg-brand-50 text-brand-700 font-medium'
                          : 'border-transparent text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                      }`}
                    >
                      {WIDGET_LABEL[id]}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </nav>

          <div className="flex-1 min-w-0">
            {orderedIds.map(id => (
              show(id) && cards[id]
                ? <Fragment key={id}>{cards[id]}</Fragment>
                : null
            ))}
          </div>
        </div>
        </>
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
