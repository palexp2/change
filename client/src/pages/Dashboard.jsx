import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import {
  Building2, TrendingUp, ShoppingCart, Package,
  LifeBuoy, DollarSign, AlertTriangle, ArrowRight, SlidersHorizontal, X, Check
} from 'lucide-react'
import api from '../lib/api.js'
import { Badge, orderStatusColor, ticketStatusColor } from '../components/Badge.jsx'
import { Layout } from '../components/Layout.jsx'
import { useAuth } from '../lib/auth.jsx'

const WIDGET_DEFS = [
  { id: 'kpi_companies',     label: 'Entreprises',          group: 'Chiffres' },
  { id: 'kpi_pipeline',      label: 'Projets en cours',     group: 'Chiffres' },
  { id: 'kpi_orders',        label: 'Commandes en cours',   group: 'Chiffres' },
  { id: 'kpi_tickets',       label: 'Tickets ouverts',      group: 'Chiffres' },
  { id: 'kpi_revenue',       label: 'Revenu ce mois',       group: 'Chiffres' },
  { id: 'kpi_won',           label: 'Gagnés ce mois',       group: 'Chiffres' },
  { id: 'kpi_stock',         label: 'Stock critique',       group: 'Chiffres' },
  { id: 'kpi_open_projects', label: 'Projets ouverts',      group: 'Chiffres' },
  { id: 'section_phases',    label: 'Entreprises par phase',group: 'Graphiques' },
  { id: 'section_closing',   label: 'Taux de closing',      group: 'Graphiques' },
  { id: 'section_orders',    label: 'Commandes récentes',   group: 'Listes' },
  { id: 'section_tickets',   label: 'Tickets récents',      group: 'Listes' },
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

function KpiCard({ title, value, subtitle, icon: Icon, color = 'indigo', to }) {
  const colors = {
    indigo: 'bg-indigo-50 text-indigo-600',
    green: 'bg-green-50 text-green-600',
    yellow: 'bg-yellow-50 text-yellow-600',
    red: 'bg-red-50 text-red-600',
    blue: 'bg-blue-50 text-blue-600',
    orange: 'bg-orange-50 text-orange-600',
  }
  const card = (
    <div className="card p-5 hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-slate-500 font-medium">{title}</p>
          <p className="text-3xl font-bold text-slate-900 mt-1">{value}</p>
          {subtitle && <p className="text-xs text-slate-400 mt-1">{subtitle}</p>}
        </div>
        <div className={`p-3 rounded-xl ${colors[color]}`}>
          <Icon size={20} />
        </div>
      </div>
    </div>
  )
  return to ? <Link to={to}>{card}</Link> : card
}

function ClosingRateChart({ data }) {
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
          <g key={m.key}>
            {m.rate !== null && (
              <circle cx={xPos(i)} cy={yPos(m.rate)} r="3.5"
                fill="white" stroke="#6366f1" strokeWidth="2"
                onMouseEnter={() => setTooltip({ i, x: xPos(i), y: yPos(m.rate), m })}
                onMouseLeave={() => setTooltip(null)}
                style={{ cursor: 'default' }}
              />
            )}
            <text x={xPos(i)} y={H - 4} textAnchor="middle" fontSize="9" fill="#94a3b8">{m.label}</text>
          </g>
        ))}
        {tooltip && (() => {
          const tx = Math.min(Math.max(tooltip.x, 60), W - 60)
          const ty = tooltip.y < padT + 40 ? tooltip.y + 16 : tooltip.y - 40
          return (
            <g>
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

  const phases = data?.companies?.byPhase || []
  const ordersMap = {}
  for (const o of (data?.orders?.byStatus || [])) ordersMap[o.status] = o.count

  const pendingOrders = (ordersMap['Confirmée'] || 0) + (ordersMap['En préparation'] || 0)

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

        {/* KPI Grid row 1 */}
        {[show('kpi_companies'), show('kpi_pipeline'), show('kpi_orders'), show('kpi_tickets')].some(Boolean) && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            {show('kpi_companies') && (
              <KpiCard title="Entreprises" value={data?.companies?.total || 0} icon={Building2} color="blue" to="/companies" />
            )}
            {show('kpi_pipeline') && (
              <KpiCard
                title="Projets en cours"
                value={fmtCad(data?.projects?.openValue)}
                subtitle={`${data?.projects?.openCount || 0} projets · ${fmtCad(data?.projects?.weightedValue)} pondéré`}
                icon={TrendingUp} color="indigo" to="/pipeline"
              />
            )}
            {show('kpi_orders') && (
              <KpiCard
                title="Commandes en cours"
                value={pendingOrders}
                subtitle={`Revenu ce mois: ${fmtCad(data?.orders?.monthlyRevenue)}`}
                icon={ShoppingCart} color="green" to="/orders"
              />
            )}
            {show('kpi_tickets') && (
              <KpiCard
                title="Tickets ouverts"
                value={data?.support?.openTickets || 0}
                icon={LifeBuoy}
                color={data?.support?.openTickets > 5 ? 'red' : 'orange'}
                to="/tickets"
              />
            )}
          </div>
        )}

        {/* KPI Grid row 2 */}
        {[show('kpi_revenue'), show('kpi_won'), show('kpi_stock'), show('kpi_open_projects')].some(Boolean) && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
            {show('kpi_revenue') && (
              <KpiCard title="Revenu ce mois" value={fmtCad(data?.orders?.monthlyRevenue)} subtitle="Commandes envoyées" icon={DollarSign} color="green" />
            )}
            {show('kpi_won') && (
              <KpiCard title="Gagnés ce mois" value={data?.projects?.wonThisMonth || 0} subtitle={fmtCad(data?.projects?.wonValueThisMonth)} icon={TrendingUp} color="green" />
            )}
            {show('kpi_stock') && data?.inventory?.lowStockCount > 0 && (
              <KpiCard title="Stock critique" value={data.inventory.lowStockCount} subtitle="produits sous le minimum" icon={AlertTriangle} color="red" to="/products" />
            )}
            {show('kpi_open_projects') && (
              <KpiCard title="Projets ouverts" value={data?.projects?.openCount || 0} icon={TrendingUp} color="indigo" to="/pipeline" />
            )}
          </div>
        )}

        {/* Companies by phase */}
        {show('section_phases') && phases.length > 0 && (
          <div className="card p-5 mb-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-semibold text-slate-900">Entreprises par phase</h2>
              <Link to="/companies" className="text-indigo-600 text-sm flex items-center gap-1 hover:underline">
                Voir toutes <ArrowRight size={14} />
              </Link>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {phases.map(p => (
                <div key={p.lifecycle_phase || 'unknown'} className="bg-slate-50 rounded-lg p-3">
                  <div className="text-2xl font-bold text-slate-900">{p.count}</div>
                  <div className="text-xs text-slate-500 mt-0.5">{p.lifecycle_phase || 'Non défini'}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Closing rate chart */}
        {show('section_closing') && (
          <div className="card p-5 mb-6">
            <div className="mb-4">
              <h2 className="font-semibold text-slate-900">Taux de closing</h2>
              <p className="text-xs text-slate-400 mt-0.5">Projets gagnés / (gagnés + perdus) par mois — 12 derniers mois</p>
            </div>
            <ClosingRateChart data={data?.closingByMonth} />
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
