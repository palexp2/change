import { useState, useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowRight, SlidersHorizontal, X, Check } from 'lucide-react'
import api from '../lib/api.js'
import { Badge, orderStatusColor, ticketStatusColor } from '../components/Badge.jsx'
import { Layout } from '../components/Layout.jsx'
import { useAuth } from '../lib/auth.jsx'
import { GeoClientsMap } from '../components/GeoClientsMap.jsx'

const WIDGET_DEFS = [
  { id: 'section_profitability',    label: 'Rentabilité',              group: 'Graphiques' },
  { id: 'section_replacement_rate', label: 'Taux de remplacement',     group: 'Graphiques' },
  { id: 'section_closing',       label: 'Taux de closing',       group: 'Graphiques' },
  { id: 'section_shipments',     label: 'Livraisons par semaine', group: 'Graphiques' },
  { id: 'section_geo_map',       label: 'Carte des clients',     group: 'Graphiques' },
  { id: 'section_support_weekly', label: 'Amélioration du support', group: 'Support' },
  { id: 'section_orders',        label: 'Commandes récentes',    group: 'Listes' },
  { id: 'section_tickets',       label: 'Tickets récents',       group: 'Listes' },
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
                      className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
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
                activeType === t ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
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
            <stop offset="0%" stopColor="#6366f1" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#6366f1" stopOpacity="0" />
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
          <path key={`line-${si}`} d={linePath(seg)} fill="none" stroke="#6366f1" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
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
                fill={tooltip?.i === i ? '#6366f1' : 'white'} stroke="#6366f1" strokeWidth="2"
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
            <stop offset="0%" stopColor="#6366f1" stopOpacity="0.9" />
            <stop offset="100%" stopColor="#6366f1" stopOpacity="0.5" />
          </linearGradient>
          <linearGradient id="shipmentsGradHover" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#4f46e5" stopOpacity="1" />
            <stop offset="100%" stopColor="#4f46e5" stopOpacity="0.7" />
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

  const maxRevenue = Math.max(...weeks.map(w => w.revenue), 1)

  const W = 600, H = 160
  const padL = 44, padR = 8, padT = 12, padB = 28
  const chartW = W - padL - padR
  const chartH = H - padT - padB
  const n = weeks.length
  const barW = Math.floor(chartW / n) - 4

  function xCenter(i) { return padL + (i + 0.5) * (chartW / n) }
  function barH(val) { return (val / maxRevenue) * chartH }

  const gridVals = [0, maxRevenue / 2, maxRevenue].map(v => Math.round(v))
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
                ? f === 'Abonnement' ? 'bg-violet-600 text-white' : f === 'Achat' ? 'bg-indigo-600 text-white' : 'bg-slate-700 text-white'
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
              <span className="text-indigo-500">{fmtCad(achatRevenue28)} achat</span>
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

      {/* Weekly bar chart */}
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 180 }}>
          <defs>
            <linearGradient id="revenueGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#6ee7b7" stopOpacity="0.9" />
              <stop offset="100%" stopColor="#34d399" stopOpacity="0.6" />
            </linearGradient>
            <linearGradient id="cogsGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#94a3b8" stopOpacity="0.9" />
              <stop offset="100%" stopColor="#64748b" stopOpacity="0.7" />
            </linearGradient>
          </defs>

          {/* Grid */}
          {gridVals.map((v, gi) => {
            const y = padT + chartH - (v / maxRevenue) * chartH
            return (
              <g key={gi}>
                <line x1={padL} x2={W - padR} y1={y} y2={y} stroke="#f1f5f9" strokeWidth={1} />
                <text x={padL - 4} y={y + 3.5} textAnchor="end" fontSize="9" fill="#94a3b8">{fmtK(v)}</text>
              </g>
            )
          })}

          {/* Bars */}
          {weeks.map((w, i) => {
            const revH = barH(w.revenue)
            const cogsH = barH(w.cogs)
            const x = xCenter(i) - barW / 2
            const isHovered = tooltip?.i === i
            const showLabel = i === 0 || i === n - 1 || w.date.getDate() <= 7
            const label = w.date.toLocaleDateString('fr-CA', { month: 'short', day: 'numeric' })
            const isLast4 = i >= n - 4
            return (
              <g key={w.key}
                onMouseEnter={() => w.revenue > 0 && setTooltip({ i, x: xCenter(i), y: padT + chartH - revH, w })}
                onMouseLeave={() => setTooltip(null)}
              >
                <rect x={padL + i * (chartW / n)} y={0} width={chartW / n} height={H} fill="transparent" />
                {revH > 0 && (
                  <rect x={x} y={padT + chartH - revH} width={barW} height={revH} rx="2"
                    fill={isHovered ? '#10b981' : 'url(#revenueGrad)'}
                    opacity={isLast4 ? 1 : 0.6}
                  />
                )}
                {cogsH > 0 && (
                  <rect x={x} y={padT + chartH - cogsH} width={barW} height={cogsH} rx="2"
                    fill={isHovered ? '#475569' : 'url(#cogsGrad)'}
                    opacity={isLast4 ? 1 : 0.6}
                  />
                )}
                {showLabel && (
                  <text x={xCenter(i)} y={H - 4} textAnchor="middle" fontSize="8" fill="#94a3b8">{label}</text>
                )}
              </g>
            )
          })}

          {/* Tooltip */}
          {tooltip && (() => {
            const tx = Math.min(Math.max(tooltip.x, 70), W - 70)
            const ty = Math.max(tooltip.y - 8, padT + 4)
            const w = tooltip.w
            const marginPct = w.revenue > 0 ? Math.round(((w.revenue - w.cogs) / w.revenue) * 100) : 0
            const hasBreakdown = activeFilter === 'Tous' && (w.subRevenue > 0 || w.achatRevenue > 0)
            return (
              <g pointerEvents="none">
                <rect x={tx - 64} y={ty - 14} width={128} height={hasBreakdown ? 68 : 52} rx="5" fill="#1e293b" opacity="0.93" />
                <text x={tx} y={ty + 2} textAnchor="middle" fontSize="10" fontWeight="bold" fill="#6ee7b7">
                  Rev: {fmtK(w.revenue)}$
                </text>
                <text x={tx} y={ty + 16} textAnchor="middle" fontSize="10" fill="#94a3b8">
                  Coûts: {fmtK(w.cogs)}$
                </text>
                <text x={tx} y={ty + 30} textAnchor="middle" fontSize="10" fontWeight="bold"
                  fill={marginPct >= 40 ? '#6ee7b7' : marginPct >= 20 ? '#fbbf24' : '#f87171'}>
                  Marge: {marginPct}%
                </text>
                {hasBreakdown && (
                  <text x={tx} y={ty + 46} textAnchor="middle" fontSize="9" fill="#a78bfa">
                    Abo {fmtK(w.subRevenue)}$ · Achat {fmtK(w.achatRevenue)}$
                  </text>
                )}
              </g>
            )
          })()}
        </svg>
        <div className="flex items-center gap-4 text-xs text-slate-400 mt-1 px-1">
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-emerald-400 inline-block" /> Revenus</span>
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-slate-400 inline-block" /> Coûts</span>
          <span className="ml-auto">Zone plus opaque = 28 derniers jours</span>
        </div>
      </div>

      {/* Shipped orders table — filtered by activeFilter */}
      {recentOrders?.length > 0 && (() => {
        const filtered = activeFilter === 'Tous' ? recentOrders
          : activeFilter === 'Abonnement' ? recentOrders.filter(o => o.is_subscription)
          : recentOrders.filter(o => !o.is_subscription)
        if (!filtered.length) return null
        return (
          <div className="mt-6 border-t border-slate-100 pt-5">
            <h3 className="text-sm font-semibold text-slate-700 mb-3">
              Commandes envoyées — 28 derniers jours ({filtered.length})
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
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
                        <td className="px-3 py-2.5 text-slate-500 whitespace-nowrap">{fmtDate(order.last_shipped_at)}</td>
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
                </tbody>
              </table>
            </div>
          </div>
        )
      })()}
    </div>
  )
}

function ReplacementRateChart({ replacementRate }) {
  const [tooltip, setTooltip] = useState(null)
  const [showItems, setShowItems] = useState(false)
  const { parkValue = 0, last28 = 0, byMonth = [], items = [] } = replacementRate || {}

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

  const maxRate = Math.max(...months.map(m => m.rate), 0.01)
  const W = 600, H = 160
  const padL = 44, padR = 8, padT = 12, padB = 28
  const chartW = W - padL - padR
  const chartH = H - padT - padB
  const n = months.length
  const barW = Math.floor(chartW / n) - 4
  function xCenter(i) { return padL + (i + 0.5) * (chartW / n) }
  function barH(val) { return (val / maxRate) * chartH }
  const gridRates = [0, maxRate / 2, maxRate]
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

      {/* Monthly bar chart */}
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 180 }}>
        <defs>
          <linearGradient id="replGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.9" />
            <stop offset="100%" stopColor="#d97706" stopOpacity="0.6" />
          </linearGradient>
        </defs>
        {gridRates.map((v, gi) => {
          const y = padT + chartH - (v / maxRate) * chartH
          return (
            <g key={gi}>
              <line x1={padL} x2={W - padR} y1={y} y2={y} stroke="#f1f5f9" strokeWidth={1} />
              <text x={padL - 4} y={y + 3.5} textAnchor="end" fontSize="9" fill="#94a3b8">{v.toFixed(2)}%</text>
            </g>
          )
        })}
        {months.map((m, i) => {
          const bh = barH(m.rate)
          const x = xCenter(i) - barW / 2
          const isHovered = tooltip?.i === i
          return (
            <g key={m.key}
              onMouseEnter={() => m.rate > 0 && setTooltip({ i, x: xCenter(i), y: padT + chartH - bh, m })}
              onMouseLeave={() => setTooltip(null)}
            >
              <rect x={padL + i * (chartW / n)} y={0} width={chartW / n} height={H} fill="transparent" />
              {bh > 0 && (
                <rect x={x} y={padT + chartH - bh} width={barW} height={bh} rx="2"
                  fill={isHovered ? '#d97706' : 'url(#replGrad)'} />
              )}

              <text x={xCenter(i)} y={H - 4} textAnchor="middle" fontSize="9" fill="#94a3b8">{m.label}</text>
            </g>
          )
        })}
        {tooltip && (() => {
          const tx = Math.min(Math.max(tooltip.x, 70), W - 70)
          const ty = Math.max(tooltip.y - 8, padT + 4)
          return (
            <g pointerEvents="none">
              <rect x={tx - 56} y={ty - 14} width={112} height={52} rx="5" fill="#1e293b" opacity="0.93" />
              <text x={tx} y={ty + 2} textAnchor="middle" fontSize="10" fontWeight="bold" fill="#fbbf24">
                {fmtPct(tooltip.m.rate)} du parc
              </text>
              <text x={tx} y={ty + 16} textAnchor="middle" fontSize="10" fill="#94a3b8">
                {fmtCad(tooltip.m.cost)}
              </text>
              <text x={tx} y={ty + 30} textAnchor="middle" fontSize="9" fill="#94a3b8">
                {tooltip.m.nb_orders} commande{tooltip.m.nb_orders > 1 ? 's' : ''}
              </text>
            </g>
          )
        })()}
      </svg>
      <p className="text-xs text-slate-400 mt-1 px-1">
        Vert ≤ 5%/an · Jaune ≤ 10%/an · Rouge &gt; 10%/an
      </p>

      {/* Replacement items detail table */}
      {items.length > 0 && (
        <div className="mt-4">
          <button
            onClick={() => setShowItems(!showItems)}
            className="text-sm text-blue-600 hover:text-blue-800 font-medium flex items-center gap-1"
          >
            <span className="text-xs">{showItems ? '▼' : '▶'}</span>
            {items.length} ligne{items.length > 1 ? 's' : ''} de remplacement (12 derniers mois)
          </button>
          {showItems && (
            <div className="mt-2 border border-slate-200 rounded-lg overflow-hidden">
              <table className="w-full text-sm">
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
                  {items.map((it, idx) => (
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
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function fmtCad(n) {
  if (!n) return '$0'
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 }).format(n)
}

function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('fr-CA', { month: 'short', day: 'numeric' })
}

export default function Dashboard() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [showEditor, setShowEditor] = useState(false)
  const { user } = useAuth()
  const navigate = useNavigate()
  const [prefs, setPrefs] = useState(() => loadPrefs(user?.id || 'default'))

  useEffect(() => {
    api.dashboard.get().then(setData).catch(console.error).finally(() => setLoading(false))
  }, [])

  function updatePrefs(newPrefs) {
    setPrefs(newPrefs)
    savePrefs(user?.id || 'default', newPrefs)
  }

  const show = (id) => prefs[id] !== false

  if (loading) {
    return (
      <Layout>
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-indigo-600" />
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
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm transition-colors ${showEditor ? 'bg-indigo-50 text-indigo-700 border border-indigo-200' : 'border border-slate-200 text-slate-600 hover:bg-slate-50'}`}
          >
            <SlidersHorizontal size={14} /> Personnaliser
          </button>
        </div>

        {showEditor && (
          <DashboardEditor prefs={prefs} onChange={updatePrefs} onClose={() => setShowEditor(false)} />
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
              <Link to="/envois" className="text-indigo-600 text-sm flex items-center gap-1 hover:underline">
                Voir tous <ArrowRight size={14} />
              </Link>
            </div>
            <ShipmentsWeeklyChart data={data?.weeklyShipments} />
          </div>
        )}

        {/* Geo clients map */}
        {show('section_geo_map') && (
          <div className="card p-5 mb-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="font-semibold text-slate-900">Clients par région</h2>
                <p className="text-xs text-slate-400 mt-0.5">Basé sur l'adresse de ferme — cliquer pour filtrer</p>
              </div>
            </div>
            <GeoClientsMap geoData={data?.geoClients || []} />
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
              <Link to="/tickets" className="text-indigo-600 text-sm flex items-center gap-1 hover:underline">
                Voir tickets <ArrowRight size={14} />
              </Link>
            </div>
            <SupportWeeklyTable data={data?.weeklySupportStats} />
          </div>
        )}

        {(show('section_orders') || show('section_tickets')) && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Recent orders */}
            {show('section_orders') && (
              <div className="card p-5">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="font-semibold text-slate-900">Commandes récentes</h2>
                  <Link to="/orders" className="text-indigo-600 text-sm flex items-center gap-1 hover:underline">
                    Voir toutes <ArrowRight size={14} />
                  </Link>
                </div>
                {data?.recentOrders?.length === 0 ? (
                  <p className="text-slate-400 text-sm py-4 text-center">Aucune commande</p>
                ) : (
                  <div className="space-y-2">
                    {data?.recentOrders?.map(order => (
                      <Link key={order.id} to={`/orders/${order.id}`}
                        className="flex items-center justify-between p-3 rounded-lg hover:bg-slate-50 transition-colors group">
                        <div>
                          <div className="text-sm font-medium text-slate-900 group-hover:text-indigo-600">
                            #{order.order_number} — {order.company_name || 'Sans entreprise'}
                          </div>
                          <div className="text-xs text-slate-400">{fmtDate(order.created_at)}</div>
                        </div>
                        <div className="flex items-center gap-2">
                          {order.total_value > 0 && <span className="text-xs text-slate-500">{fmtCad(order.total_value)}</span>}
                          <Badge color={orderStatusColor(order.status)}>{order.status}</Badge>
                        </div>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Recent tickets */}
            {show('section_tickets') && (
              <div className="card p-5">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="font-semibold text-slate-900">Tickets récents</h2>
                  <Link to="/tickets" className="text-indigo-600 text-sm flex items-center gap-1 hover:underline">
                    Voir tous <ArrowRight size={14} />
                  </Link>
                </div>
                {data?.recentTickets?.length === 0 ? (
                  <p className="text-slate-400 text-sm py-4 text-center">Aucun ticket</p>
                ) : (
                  <div className="space-y-2">
                    {data?.recentTickets?.map(ticket => (
                      <Link key={ticket.id} to="/tickets"
                        className="flex items-center justify-between p-3 rounded-lg hover:bg-slate-50 transition-colors group">
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium text-slate-900 truncate group-hover:text-indigo-600">
                            {ticket.title}
                          </div>
                          <div className="text-xs text-slate-400">{ticket.company_name} · {fmtDate(ticket.created_at)}</div>
                        </div>
                        <Badge color={ticketStatusColor(ticket.status)}>{ticket.status}</Badge>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </Layout>
  )
}
