import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { BarChart3, Table2, ArrowUpRight, ArrowDownRight, AlertTriangle, RefreshCw } from 'lucide-react'
import api from '../lib/api.js'

/* ── Vue globale du tableau de bord ────────────────────────────────────────
   Le pendant « Power BI » des sections du dashboard : une planche dense où
   tout se lit d'un coup d'œil — un chiffre héros (la trésorerie), une bande
   d'indicateurs, six graphiques compacts, deux tableaux.

   Règles de dataviz appliquées ici :
   - Une seule série par graphique → une seule teinte, pas de légende.
   - Jamais deux échelles verticales sur un même graphique.
   - Marques fines, grille en filet plein (jamais pointillé), étiquettes
     d'axe parcimonieuses ; la valeur exacte se lit au survol OU dans la
     vue tableau (bouton dans l'en-tête de chaque carte) — jamais uniquement
     dans l'infobulle.
   - Couleurs posées par des classes Tailwind (`fill-*`, `stroke-*`) et non
     en dur : le mode nuit suit. */

/* ── Formats ─────────────────────────────────────────────────────────── */

function fmtMoney(n) {
  if (n == null || Number.isNaN(n)) return '—'
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 }).format(n)
}

function fmtMoneyCompact(n) {
  if (n == null || Number.isNaN(n)) return '—'
  if (Math.abs(n) >= 10000) {
    return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD', notation: 'compact', maximumFractionDigits: 1 }).format(n)
  }
  return fmtMoney(n)
}

function fmtInt(n) {
  return new Intl.NumberFormat('fr-CA').format(Math.round(n || 0))
}

function fmtPct(n, digits = 1) {
  if (n == null || Number.isNaN(n)) return '—'
  return `${n.toFixed(digits).replace('.', ',')} %`
}

/* ── Teintes ─────────────────────────────────────────────────────────────
   Une entrée par domaine. Les classes sont écrites en toutes lettres :
   Tailwind ne voit que ce qui est littéral dans le source. */
const TONES = {
  brand:   { stroke: 'stroke-brand-500',   fill: 'fill-brand-500',   wash: 'fill-brand-500/10',   track: 'bg-brand-100',   bar: 'bg-brand-500',   text: 'text-brand-700' },
  sky:     { stroke: 'stroke-sky-600',     fill: 'fill-sky-600',     wash: 'fill-sky-600/10',     track: 'bg-sky-100',     bar: 'bg-sky-500',     text: 'text-sky-700' },
  violet:  { stroke: 'stroke-violet-500',  fill: 'fill-violet-500',  wash: 'fill-violet-500/10',  track: 'bg-violet-100',  bar: 'bg-violet-500',  text: 'text-violet-700' },
  amber:   { stroke: 'stroke-amber-500',   fill: 'fill-amber-500',   wash: 'fill-amber-500/10',   track: 'bg-amber-100',   bar: 'bg-amber-500',   text: 'text-amber-700' },
  rose:    { stroke: 'stroke-rose-500',    fill: 'fill-rose-500',    wash: 'fill-rose-500/10',    track: 'bg-rose-100',    bar: 'bg-rose-500',    text: 'text-rose-700' },
  teal:    { stroke: 'stroke-teal-600',    fill: 'fill-teal-600',    wash: 'fill-teal-600/10',    track: 'bg-teal-100',    bar: 'bg-teal-500',    text: 'text-teal-700' },
  slate:   { stroke: 'stroke-slate-400',   fill: 'fill-slate-400',   wash: 'fill-slate-400/10',   track: 'bg-slate-100',   bar: 'bg-slate-400',   text: 'text-slate-700' },
}

/* ── Géométrie commune des graphiques ─────────────────────────────────────
   La hauteur du viewBox inclut la bande des étiquettes d'axe : la carte n'a
   donc jamais de mini-ascenseur vertical. */
const CW = 320, CH = 138
const PAD_L = 34, PAD_R = 6, PAD_T = 10, PAD_B = 18
const PLOT_H = CH - PAD_T - PAD_B
// Largeur de viewBox de la bande héros : plus large, donc moins étirée.
const HERO_VW = 600

// Arrondit une borne d'axe vers le haut sur une valeur « propre » (1, 2, 2,5, 5 × 10ⁿ).
function niceCeil(v) {
  if (!(v > 0)) return 1
  const mag = Math.pow(10, Math.floor(Math.log10(v)))
  const n = v / mag
  const step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(s => n <= s) || 10
  return step * mag
}

// Borne haute d'axe ET graduation médiane, toutes deux « rondes » : on arrondit
// la moitié puis on double. Sans ça, une médiane à max/2 tombe sur 7,5 et
// s'affiche « 8 » à la mauvaise hauteur.
function axisScale(rawMax) {
  const half = niceCeil(rawMax / 2)
  return { top: half * 2, half }
}

// Barre à extrémité-donnée arrondie et pied carré sur la ligne de base.
// `down` inverse la géométrie pour les valeurs négatives (arrondi vers le bas).
function barPath(x, y, w, h, { down = false, r = 3 } = {}) {
  if (h <= 0) return ''
  const rr = Math.max(0, Math.min(r, w / 2, h))
  if (down) {
    return `M${x},${y} L${x},${y + h - rr} Q${x},${y + h} ${x + rr},${y + h} L${x + w - rr},${y + h} Q${x + w},${y + h} ${x + w},${y + h - rr} L${x + w},${y} Z`
  }
  return `M${x},${y + h} L${x},${y + rr} Q${x},${y} ${x + rr},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h} Z`
}

function ChartTooltip({ hover }) {
  if (!hover) return null
  return (
    <div
      className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-[calc(100%+6px)] whitespace-nowrap rounded-md px-2 py-1 text-[11px] leading-tight shadow-lg text-fixed-white"
      style={{ left: `${hover.xPct}%`, top: `${hover.yPct}%`, background: 'rgba(15,23,42,0.94)' }}
    >
      <div className="font-semibold">{hover.value}</div>
      <div className="opacity-70">{hover.label}</div>
    </div>
  )
}

function EmptyPlot({ label = 'Pas encore de données' }) {
  return <div className="flex h-[132px] items-center justify-center text-xs text-slate-300">{label}</div>
}

/* Étiquettes d'axe : on ancre sur le DERNIER point et on remonte de
   `labelEvery` en `labelEvery`. La période la plus récente est toujours
   nommée et aucune étiquette ne vient en télescoper une autre. */
function labelAt(i, n, every) {
  return (n - 1 - i) % every === 0
}

/* Colonnes — une seule série, une seule teinte.
   `vw` = largeur du viewBox : les cartes larges (la bande héros) en prennent
   une plus grande pour que le texte ne soit pas agrandi par la mise à
   l'échelle uniforme du SVG. */
function MiniColumns({ points, tone = 'brand', format = fmtInt, labelEvery = 2, vw = CW }) {
  const [hover, setHover] = useState(null)
  const t = TONES[tone] || TONES.brand
  if (!points?.length) return <EmptyPlot />

  const plotW = vw - PAD_L - PAD_R
  const { top: max, half } = axisScale(Math.max(...points.map(p => p.value || 0), 0))
  const n = points.length
  const band = plotW / n
  const barW = Math.max(2, Math.min(20, band - 4))
  const yOf = v => PAD_T + PLOT_H - (max ? (Math.max(0, v) / max) * PLOT_H : 0)
  const ticks = [0, half, max]

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${vw} ${CH}`} className="w-full" style={{ height: 'auto' }} role="img">
        {ticks.map(v => (
          <g key={v}>
            <line x1={PAD_L} x2={vw - PAD_R} y1={yOf(v)} y2={yOf(v)} className="stroke-slate-200" strokeWidth={0.6} />
            <text x={PAD_L - 4} y={yOf(v) + 2.6} textAnchor="end" fontSize="7" className="fill-slate-400 tabular-nums">
              {format(v)}
            </text>
          </g>
        ))}
        {points.map((p, i) => {
          const x = PAD_L + i * band + (band - barW) / 2
          const y = yOf(p.value)
          const h = PAD_T + PLOT_H - y
          return (
            <g key={p.key}
              onMouseEnter={() => setHover({ xPct: ((PAD_L + (i + 0.5) * band) / vw) * 100, yPct: (y / CH) * 100, value: format(p.value), label: p.label })}
              onMouseLeave={() => setHover(null)}
            >
              <rect x={PAD_L + i * band} y={0} width={band} height={CH} fill="transparent" />
              {h > 0.5 && <path d={barPath(x, y, barW, h)} className={`${t.fill} ${hover && hover.label === p.label ? 'opacity-100' : 'opacity-90'}`} />}
              {labelAt(i, n, labelEvery) && (
                <text x={PAD_L + (i + 0.5) * band} y={CH - 5} textAnchor="middle" fontSize="7" className="fill-slate-400">
                  {p.short ?? p.label}
                </text>
              )}
            </g>
          )
        })}
      </svg>
      <ChartTooltip hover={hover} />
    </div>
  )
}

/* Ligne — 2 px, lavis à 10 %, point terminal cerclé de la surface et étiqueté. */
function MiniLine({ points, tone = 'brand', format = fmtInt, labelEvery = 2, vw = CW }) {
  const [hover, setHover] = useState(null)
  const t = TONES[tone] || TONES.brand
  if (!points?.length) return <EmptyPlot />

  const plotW = vw - PAD_L - PAD_R
  const values = points.map(p => p.value || 0)
  const rawMax = Math.max(...values, 0)
  const rawMin = Math.min(...values, 0)
  const scale = axisScale(rawMax)
  const max = rawMin < 0 ? (niceCeil(rawMax) || 1) : scale.top
  const min = rawMin < 0 ? -niceCeil(-rawMin) : 0
  const n = points.length
  const step = n > 1 ? plotW / (n - 1) : 0
  const xOf = i => PAD_L + i * step
  const yOf = v => PAD_T + PLOT_H - ((v - min) / (max - min || 1)) * PLOT_H
  const ticks = min < 0 ? [min, 0, max] : [0, scale.half, max]

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(i)},${yOf(p.value)}`).join(' ')
  const area = `${line} L${xOf(n - 1)},${yOf(min)} L${xOf(0)},${yOf(min)} Z`
  const last = points[n - 1]

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${vw} ${CH}`} className="w-full" style={{ height: 'auto' }} role="img">
        {ticks.map(v => (
          <g key={v}>
            <line x1={PAD_L} x2={vw - PAD_R} y1={yOf(v)} y2={yOf(v)} className="stroke-slate-200" strokeWidth={0.6} />
            <text x={PAD_L - 4} y={yOf(v) + 2.6} textAnchor="end" fontSize="7" className="fill-slate-400 tabular-nums">
              {format(v)}
            </text>
          </g>
        ))}
        <path d={area} className={t.wash} />
        <path d={line} fill="none" className={t.stroke} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        {points.map((p, i) => {
          const isLast = i === n - 1
          return (
            <g key={p.key}
              onMouseEnter={() => setHover({ xPct: (xOf(i) / vw) * 100, yPct: (yOf(p.value) / CH) * 100, value: format(p.value), label: p.label })}
              onMouseLeave={() => setHover(null)}
            >
              <rect x={xOf(i) - step / 2} y={0} width={Math.max(step, 8)} height={CH} fill="transparent" />
              {(isLast || hover?.label === p.label) && (
                <circle cx={xOf(i)} cy={yOf(p.value)} r={3} className={`${t.fill} stroke-white`} strokeWidth={1.6} />
              )}
              {labelAt(i, n, labelEvery) && (
                // Les points extrêmes sont sur le bord du tracé : on ancre
                // leur étiquette vers l'intérieur pour ne pas la rogner.
                <text x={xOf(i)} y={CH - 5} textAnchor={isLast ? 'end' : i === 0 ? 'start' : 'middle'} fontSize="7" className="fill-slate-400">
                  {p.short ?? p.label}
                </text>
              )}
            </g>
          )
        })}
        {/* Étiquette directe sur le dernier point : la valeur du jour ne
            dépend jamais du survol. */}
        <text x={Math.min(xOf(n - 1), vw - PAD_R - 2)} y={Math.max(yOf(last.value) - 7, PAD_T + 4)} textAnchor="end" fontSize="8" fontWeight="600" className="fill-slate-600 tabular-nums">
          {format(last.value)}
        </text>
      </svg>
      <ChartTooltip hover={hover} />
    </div>
  )
}

/* Colonnes divergentes — la couleur porte le signe (hausse / baisse). */
function DivergingColumns({ points, format = fmtMoneyCompact, labelEvery = 2, vw = CW }) {
  const [hover, setHover] = useState(null)
  if (!points?.length) return <EmptyPlot />

  const plotW = vw - PAD_L - PAD_R
  const maxAbs = niceCeil(Math.max(...points.map(p => Math.abs(p.value || 0)), 0))
  const n = points.length
  const band = plotW / n
  const barW = Math.max(2, Math.min(18, band - 4))
  const zeroY = PAD_T + PLOT_H / 2
  const halfH = PLOT_H / 2
  const yOf = v => zeroY - (v / maxAbs) * halfH

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${vw} ${CH}`} className="w-full" style={{ height: 'auto' }} role="img">
        {[maxAbs, -maxAbs].map(v => (
          <g key={v}>
            <line x1={PAD_L} x2={vw - PAD_R} y1={yOf(v)} y2={yOf(v)} className="stroke-slate-200" strokeWidth={0.6} />
            <text x={PAD_L - 4} y={yOf(v) + 2.6} textAnchor="end" fontSize="7" className="fill-slate-400 tabular-nums">{format(v)}</text>
          </g>
        ))}
        <line x1={PAD_L} x2={vw - PAD_R} y1={zeroY} y2={zeroY} className="stroke-slate-300" strokeWidth={0.8} />
        {points.map((p, i) => {
          const v = p.value || 0
          const x = PAD_L + i * band + (band - barW) / 2
          const h = Math.abs(yOf(v) - zeroY)
          const y = v >= 0 ? zeroY - h : zeroY
          return (
            <g key={p.key}
              onMouseEnter={() => setHover({ xPct: ((PAD_L + (i + 0.5) * band) / vw) * 100, yPct: (Math.min(y, zeroY) / CH) * 100, value: format(v), label: p.label })}
              onMouseLeave={() => setHover(null)}
            >
              <rect x={PAD_L + i * band} y={0} width={band} height={CH} fill="transparent" />
              {h > 0.5 && (
                v >= 0
                  ? <path d={barPath(x, y, barW, h)} className="fill-emerald-500 opacity-90" />
                  : <path d={barPath(x, zeroY, barW, h, { down: true })} className="fill-rose-500 opacity-90" />
              )}
              {labelAt(i, n, labelEvery) && (
                <text x={PAD_L + (i + 0.5) * band} y={CH - 5} textAnchor="middle" fontSize="7" className="fill-slate-400">
                  {p.short ?? p.label}
                </text>
              )}
            </g>
          )
        })}
      </svg>
      <ChartTooltip hover={hover} />
    </div>
  )
}

/* Le jumeau tableau de n'importe quel graphique : aucune valeur n'est
   accessible uniquement au survol. */
function PointsTable({ points, format, valueLabel = 'Valeur', periodLabel = 'Période' }) {
  return (
    <table className="w-full text-xs">
      <thead className="sticky top-0 bg-white">
        <tr className="border-b border-slate-200 text-left text-[11px] text-slate-500">
          <th className="py-1 pr-2 font-medium">{periodLabel}</th>
          <th className="py-1 pl-2 text-right font-medium">{valueLabel}</th>
        </tr>
      </thead>
      <tbody>
        {[...points].reverse().map(p => (
          <tr key={p.key} className="border-b border-slate-100 text-slate-600">
            <td className="py-1 pr-2">{p.label}</td>
            <td className="py-1 pl-2 text-right tabular-nums">{format(p.value)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/* Carte de graphique : titre, sous-titre, bascule graphique ↔ tableau,
   lien de détail vers la section correspondante du dashboard classique. */
function ChartCard({ id, title, subtitle, to, points, format, valueLabel, periodLabel, children, className = '' }) {
  const [asTable, setAsTable] = useState(false)
  return (
    <div className={`card p-3 ${className}`} data-testid={`overview-chart-${id}`}>
      <div className="mb-2 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[13px] font-semibold text-slate-800">
            {to ? <Link to={to} className="hover:text-brand-700 hover:underline">{title}</Link> : title}
          </h3>
          {subtitle && <p className="truncate text-[11px] text-slate-400">{subtitle}</p>}
        </div>
        <button
          type="button"
          onClick={() => setAsTable(v => !v)}
          aria-pressed={asTable}
          aria-label={asTable ? 'Afficher le graphique' : 'Afficher le tableau'}
          title={asTable ? 'Afficher le graphique' : 'Afficher le tableau'}
          data-testid={`overview-chart-toggle-${id}`}
          className="shrink-0 rounded p-1 text-slate-300 transition-colors hover:bg-slate-50 hover:text-slate-600"
        >
          {asTable ? <BarChart3 size={14} /> : <Table2 size={14} />}
        </button>
      </div>
      {asTable
        ? <div className="max-h-[132px] overflow-y-auto" data-testid={`overview-chart-table-${id}`}>
            <PointsTable points={points} format={format} valueLabel={valueLabel} periodLabel={periodLabel} />
          </div>
        : children}
    </div>
  )
}

/* ── Tuiles ──────────────────────────────────────────────────────────── */

function Meter({ pct, tone = 'brand' }) {
  const t = TONES[tone] || TONES.brand
  return (
    <div className={`mt-2 h-1.5 overflow-hidden rounded-full ${t.track}`}>
      <div className={`h-full rounded-full ${t.bar} transition-all`} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  )
}

function Tile({ id, label, value, sub, tone = 'slate', meter, delta, to, loading }) {
  const t = TONES[tone] || TONES.slate
  const inner = (
    <div className={`card flex h-full flex-col p-3 transition-colors ${to ? 'hover:border-slate-300' : ''} ${loading ? 'opacity-50' : ''}`} data-testid={`overview-tile-${id}`}>
      <p className="text-[11px] leading-tight text-slate-500">{label}</p>
      <p className={`mt-1 text-[19px] font-semibold leading-none ${t.text}`}>{value}</p>
      <div className="mt-auto">
        {delta != null && (
          <p className={`mt-1.5 flex items-center gap-0.5 text-[11px] ${delta.good ? 'text-emerald-600' : 'text-rose-600'}`}>
            {delta.value >= 0 ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
            <span className="tabular-nums">{delta.text}</span>
            <span className="text-slate-400">{delta.period}</span>
          </p>
        )}
        {sub && <p className="mt-1 truncate text-[11px] text-slate-400">{sub}</p>}
        {meter && <Meter pct={meter.pct} tone={meter.tone || tone} />}
      </div>
    </div>
  )
  return to ? <Link to={to} className="block h-full">{inner}</Link> : inner
}

/* ── Séries dérivées ─────────────────────────────────────────────────── */

const MONTH_SHORT = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.']

function lastMonthKeys(n) {
  const out = []
  const d = new Date()
  d.setDate(1)
  for (let i = n - 1; i >= 0; i--) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1)
    out.push({
      key: `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`,
      label: `${MONTH_SHORT[m.getMonth()]} ${m.getFullYear()}`,
      short: MONTH_SHORT[m.getMonth()].replace('.', ''),
    })
  }
  return out
}

function lastMondayKeys(n) {
  const out = []
  const today = new Date()
  const monday = new Date(today)
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7))
  monday.setHours(0, 0, 0, 0)
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(monday)
    d.setDate(monday.getDate() - i * 7)
    out.push({
      key: d.toISOString().slice(0, 10),
      label: `Sem. du ${d.toLocaleDateString('fr-CA', { day: 'numeric', month: 'short' })}`,
      short: d.toLocaleDateString('fr-CA', { day: 'numeric', month: 'short' }),
    })
  }
  return out
}

/* ── La planche ──────────────────────────────────────────────────────── */

export function DashboardOverview({ data, subscriptionEvents }) {
  const [bank, setBank] = useState(null)
  const [bankError, setBankError] = useState(null)
  const [history, setHistory] = useState(null)
  const [deferred, setDeferred] = useState(null)
  const [aging, setAging] = useState(null)
  const [reloading, setReloading] = useState(false)

  const loadFinance = (opts = {}) => {
    setBankError(null)
    api.dashboard.bankAccounts(opts).then(setBank).catch(e => setBankError(e?.message || 'Erreur QuickBooks'))
    api.dashboard.bankAccountsHistory({ months: 12, ...opts }).then(setHistory).catch(() => setHistory({ months: [] }))
    api.dashboard.deferredRevenue().then(setDeferred).catch(() => setDeferred(null))
    api.dashboard.agingReceivables().then(setAging).catch(() => setAging(null))
  }

  useEffect(() => { loadFinance() }, [])

  function refreshFinance() {
    setReloading(true)
    setBank(null)
    loadFinance({ refresh: true })
    // Le rafraîchissement QB peut prendre quelques secondes ; on rend la main
    // dès que les soldes reviennent (l'effet ci-dessous suit `bank`).
    setTimeout(() => setReloading(false), 1200)
  }

  /* Trésorerie */
  const treasury = bank?.treasury ?? bank?.totals?.net ?? null
  const creditLimit = bank?.credit_limit || 0
  const headroom = treasury != null ? treasury + creditLimit : null
  const headroomPct = creditLimit && headroom != null ? Math.max(0, Math.min(1, headroom / creditLimit)) : 0
  const headroomTone = headroomPct > 0.5 ? 'brand' : headroomPct > 0.2 ? 'amber' : 'rose'

  const treasurySeries = useMemo(() => (history?.months || []).map(m => {
    const [y, mo] = m.month.split('-').map(Number)
    return { key: m.month, label: `${MONTH_SHORT[mo - 1]} ${y}`, short: MONTH_SHORT[mo - 1].replace('.', ''), value: m.treasury }
  }), [history])

  /* Rentabilité — 16 semaines, sommes hebdomadaires */
  const profitWeeks = useMemo(() => {
    const rows = data?.weeklyProfitability || []
    const byWeek = new Map()
    for (const r of rows) {
      const cur = byWeek.get(r.week_start) || { revenue: 0, cogs: 0 }
      cur.revenue += Number(r.revenue) || 0
      cur.cogs += Number(r.cogs) || 0
      byWeek.set(r.week_start, cur)
    }
    return lastMondayKeys(16).map(w => {
      const v = byWeek.get(w.key) || { revenue: 0, cogs: 0 }
      return { ...w, revenue: v.revenue, cogs: v.cogs }
    })
  }, [data])

  const sum = (arr, k) => arr.reduce((s, x) => s + (x[k] || 0), 0)
  const revenueSeries = profitWeeks.map(w => ({ ...w, value: w.revenue }))
  // Marge en fenêtre glissante de 28 jours (4 semaines) : une semaine sans
  // expédition n'a pas de marge — la lisser évite les chutes à 0 % qui ne
  // veulent rien dire. Même convention que la section « Rentabilité ».
  const marginSeries = profitWeeks.map((w, i) => {
    const win = profitWeeks.slice(Math.max(0, i - 3), i + 1)
    const rev = sum(win, 'revenue')
    return { ...w, label: `4 sem. au ${w.short}`, value: rev > 0 ? ((rev - sum(win, 'cogs')) / rev) * 100 : 0 }
  })

  const last4 = profitWeeks.slice(-4)
  const prev4 = profitWeeks.slice(-8, -4)
  const rev28 = sum(last4, 'revenue')
  const revPrev28 = sum(prev4, 'revenue')
  const margin28 = rev28 > 0 ? ((rev28 - sum(last4, 'cogs')) / rev28) * 100 : 0
  const revDeltaPct = revPrev28 > 0 ? ((rev28 - revPrev28) / revPrev28) * 100 : null

  /* Projets créés, closing, billets */
  const projectsSeries = useMemo(() => {
    const by = new Map((data?.projectsCreatedByMonth || []).map(r => [r.month, r.count]))
    return lastMonthKeys(12).map(m => ({ ...m, value: by.get(m.key) || 0 }))
  }, [data])

  const closingSeries = useMemo(() => {
    const by = new Map()
    for (const r of data?.closingByMonth || []) {
      const cur = by.get(r.month) || { won: 0, lost: 0 }
      cur.won += Number(r.won) || 0
      cur.lost += Number(r.lost) || 0
      by.set(r.month, cur)
    }
    return lastMonthKeys(12).map(m => {
      const v = by.get(m.key) || { won: 0, lost: 0 }
      const total = v.won + v.lost
      return { ...m, value: total ? (v.won / total) * 100 : 0, won: v.won, total }
    })
  }, [data])

  const closing12 = closingSeries.reduce((acc, m) => ({ won: acc.won + m.won, total: acc.total + m.total }), { won: 0, total: 0 })
  const closingRate12 = closing12.total ? (closing12.won / closing12.total) * 100 : 0

  const ticketsSeries = useMemo(() => {
    const by = new Map((data?.ticketsByMonth || []).map(r => [r.month, r.count]))
    return lastMonthKeys(12).map(m => ({ ...m, value: by.get(m.key) || 0 }))
  }, [data])

  const shipmentsSeries = useMemo(() => {
    const by = new Map((data?.weeklyShipments || []).map(r => [r.week_start, r.count]))
    return lastMondayKeys(16).map(w => ({ ...w, value: by.get(w.key) || 0 }))
  }, [data])

  const mrrSeries = useMemo(() => {
    const by = new Map((subscriptionEvents?.months || []).map(m => [m.month, m.net_mrr_delta_cad]))
    return lastMonthKeys(12).map(m => ({ ...m, value: Number(by.get(m.key)) || 0 }))
  }, [subscriptionEvents])

  /* Indicateurs ponctuels */
  const goal = data?.projectGoal || {}
  const goalPct = goal.target > 0 ? (goal.current / goal.target) * 100 : 0
  const inventory = data?.inventory?.valuation || {}
  const serialsValue = (inventory.serialsByStatus || []).reduce((s, r) => s + (r.total_value || 0), 0)
  const inventoryTotal = (inventory.pieces?.total_value || 0) + serialsValue
  const parkValue = data?.replacementRate?.parkValue || 0
  const replacement28 = parkValue > 0 ? ((data?.replacementRate?.last28 || 0) / parkValue) * 100 : 0
  const shippingCosts = data?.weeklyShippingCosts || []
  const shipping28 = shippingCosts.length ? shippingCosts[shippingCosts.length - 1].amount : 0
  const agingTotal = aging?.total ?? null
  const aging90 = aging?.buckets?.find(b => b.key === 'b90')?.total || 0
  const failedSections = Object.keys(data?._errors || {})

  const bankRows = bank?.accounts || []
  const banks = bankRows.filter(a => a.type === 'Bank')
  const cards = bankRows.filter(a => a.type === 'Credit Card')

  return (
    <div data-testid="dashboard-overview" className="space-y-3">
      {failedSections.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>Certaines données n'ont pas pu être calculées : {failedSections.join(', ')}. Les tuiles concernées peuvent être vides.</span>
        </div>
      )}

      {/* Bande héros — la trésorerie, seul grand chiffre de la planche. */}
      <section className="card p-4" data-testid="overview-hero">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
          <div>
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Trésorerie nette</p>
              <button
                type="button"
                onClick={refreshFinance}
                aria-label="Rafraîchir les soldes QuickBooks"
                title="Rafraîchir les soldes QuickBooks"
                className="rounded p-1 text-slate-300 transition-colors hover:bg-slate-50 hover:text-slate-600"
              >
                <RefreshCw size={13} className={reloading ? 'animate-spin' : ''} />
              </button>
            </div>
            {bankError ? (
              <p className="mt-2 text-sm text-rose-600" data-testid="overview-treasury-error">
                Soldes QuickBooks indisponibles : {bankError}
              </p>
            ) : treasury == null ? (
              <p className="mt-2 h-12 text-slate-300">Chargement des soldes…</p>
            ) : (
              <>
                <p
                  className={`mt-1 text-[44px] font-semibold leading-none ${treasury < 0 ? 'text-rose-600' : 'text-slate-900'}`}
                  data-testid="overview-treasury"
                >
                  {fmtMoney(treasury)}
                </p>
                <p className="mt-2 text-xs text-slate-500">
                  Banques <span className="font-medium text-slate-700 tabular-nums">{fmtMoney(bank?.totals?.bank || 0)}</span>
                  {' · '}
                  Cartes &amp; marges <span className="font-medium text-slate-700 tabular-nums">{fmtMoney(bank?.totals?.credit_card || 0)}</span>
                </p>
                {creditLimit > 0 && (
                  <div className="mt-3">
                    <div className="flex items-baseline justify-between text-[11px]">
                      <span className="text-slate-500">Coussin avant la limite de marge</span>
                      <span className="font-medium text-slate-700 tabular-nums">
                        {fmtMoney(headroom)} · {Math.round(headroomPct * 100)} %
                      </span>
                    </div>
                    <Meter pct={headroomPct * 100} tone={headroomTone} />
                  </div>
                )}
              </>
            )}
          </div>
          <div>
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">Évolution — 12 derniers mois</p>
            {treasurySeries.length
              ? <MiniLine points={treasurySeries} tone="brand" format={fmtMoneyCompact} labelEvery={2} vw={HERO_VW} />
              : <EmptyPlot label="Historique QuickBooks indisponible" />}
          </div>
        </div>
      </section>

      {/* Bande d'indicateurs */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6" data-testid="overview-tiles">
        <Tile
          id="revenue"
          label="Revenus expédiés — 28 j"
          value={fmtMoneyCompact(rev28)}
          tone="brand"
          to="/dashboard/rentabilite"
          delta={revDeltaPct == null ? null : {
            value: revDeltaPct,
            good: revDeltaPct >= 0,
            text: `${revDeltaPct >= 0 ? '+' : ''}${revDeltaPct.toFixed(0)} %`,
            period: 'vs 4 sem. préc.',
          }}
        />
        <Tile
          id="margin"
          label="Marge brute — 28 j"
          value={fmtPct(margin28, 0)}
          tone="brand"
          sub={`Coût des marchandises ${fmtMoneyCompact(sum(last4, 'cogs'))}`}
          to="/dashboard/rentabilite"
        />
        {/* Projets : on lit les mêmes sources que les sections « Projets créés »
            et « Taux de closing » (creation + cf_vendu). Les agrégats
            projects.openValue / wonThisMonth du endpoint reposent sur la colonne
            `status`, restée à « Ouvert » sur tous les projets importés
            d'Airtable — ils ne veulent rien dire et ne sont donc pas affichés. */}
        <Tile
          id="projects"
          label="Projets créés ce mois"
          value={fmtInt(projectsSeries[projectsSeries.length - 1]?.value)}
          tone="sky"
          sub={`${fmtInt(projectsSeries.slice(-12).reduce((s, m) => s + m.value, 0))} sur 12 mois`}
          to="/pipeline"
        />
        <Tile
          id="closing"
          label="Taux de closing — 12 mois"
          value={fmtPct(closingRate12, 0)}
          tone="sky"
          sub={`${fmtInt(closing12.won)} vendus sur ${fmtInt(closing12.total)} projets tranchés`}
          to="/dashboard/taux-de-closing"
        />
        <Tile
          id="goal"
          label="Objectif de projets"
          value={`${fmtInt(goal.current)} / ${fmtInt(goal.target)}`}
          tone="brand"
          sub={`${Math.round(goalPct)} % de la cible`}
          meter={{ pct: goalPct, tone: goalPct >= 100 ? 'brand' : goalPct >= 60 ? 'amber' : 'rose' }}
          to="/dashboard/objectif-de-projets"
        />
        <Tile
          id="deferred"
          label="Revenus perçus d'avance"
          value={deferred ? fmtMoneyCompact(deferred.total_cad || 0) : '…'}
          tone="amber"
          sub={deferred ? `${(deferred.items || []).length} facture(s) en attente d'expédition` : 'Chargement…'}
          to="/dashboard/revenus-percus-avance"
          loading={!deferred}
        />
        <Tile
          id="aging"
          label="Comptes clients en retard"
          value={agingTotal == null ? '…' : fmtMoneyCompact(agingTotal)}
          tone={aging90 > 0 ? 'rose' : 'slate'}
          sub={agingTotal == null ? 'Chargement…' : `dont ${fmtMoneyCompact(aging90)} à 90 j et +`}
          to="/factures"
          loading={agingTotal == null}
        />
        <Tile
          id="inventory"
          label="Valeur de l'inventaire"
          value={fmtMoneyCompact(inventoryTotal)}
          tone="teal"
          sub={`Pièces ${fmtMoneyCompact(inventory.pieces?.total_value || 0)} · Série ${fmtMoneyCompact(serialsValue)}`}
          to="/dashboard/valeur-inventaire"
        />
        <Tile
          id="replacement"
          label="Taux de remplacement — 28 j"
          value={fmtPct(replacement28, 2)}
          tone={replacement28 > 0.5 ? 'rose' : 'teal'}
          sub={`Parc ${fmtMoneyCompact(parkValue)}`}
          to="/dashboard/taux-de-remplacement"
        />
        <Tile
          id="shipping"
          label="Coûts d'expédition — 28 j"
          value={fmtMoneyCompact(shipping28)}
          tone="amber"
          sub="Compte 65000"
          to="/dashboard/couts-expedition"
        />
        <Tile
          id="tickets"
          label="Billets ouverts"
          value={fmtInt(data?.support?.openTickets)}
          tone="violet"
          sub={`${fmtInt(ticketsSeries[ticketsSeries.length - 1]?.value)} billets créés ce mois`}
          to="/tickets"
        />
        <Tile
          id="lowstock"
          label="Produits sous le seuil"
          value={fmtInt(data?.inventory?.lowStockCount)}
          tone={data?.inventory?.lowStockCount > 0 ? 'rose' : 'slate'}
          sub="Stock au niveau minimum ou en dessous"
          to="/products"
        />
      </section>

      {/* Graphiques compacts */}
      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="overview-charts">
        <ChartCard
          id="projects" title="Projets créés" subtitle="12 derniers mois"
          to="/dashboard/projets-crees"
          points={projectsSeries} format={fmtInt} valueLabel="Projets" periodLabel="Mois"
        >
          <MiniColumns points={projectsSeries} tone="brand" format={fmtInt} />
        </ChartCard>

        <ChartCard
          id="closing" title="Taux de closing" subtitle="Vendus / (vendus + non vendus) · 12 mois"
          to="/dashboard/taux-de-closing"
          points={closingSeries} format={v => fmtPct(v, 0)} valueLabel="Taux" periodLabel="Mois"
        >
          <MiniLine points={closingSeries} tone="sky" format={v => fmtPct(v, 0)} />
        </ChartCard>

        <ChartCard
          id="margin" title="Marge brute hebdomadaire" subtitle="Commandes expédiées · 16 semaines"
          to="/dashboard/rentabilite"
          points={marginSeries} format={v => fmtPct(v, 0)} valueLabel="Marge" periodLabel="Semaine"
        >
          <MiniLine points={marginSeries} tone="brand" format={v => fmtPct(v, 0)} labelEvery={4} />
        </ChartCard>

        <ChartCard
          id="revenue" title="Revenus expédiés" subtitle="Hors taxes · 16 semaines"
          to="/dashboard/rentabilite"
          points={revenueSeries} format={fmtMoneyCompact} valueLabel="Revenus" periodLabel="Semaine"
        >
          <MiniColumns points={revenueSeries} tone="brand" format={fmtMoneyCompact} labelEvery={4} />
        </ChartCard>

        <ChartCard
          id="shipments" title="Livraisons" subtitle="Colis envoyés · 16 semaines"
          to="/dashboard/livraisons"
          points={shipmentsSeries} format={fmtInt} valueLabel="Colis" periodLabel="Semaine"
        >
          <MiniColumns points={shipmentsSeries} tone="sky" format={fmtInt} labelEvery={4} />
        </ChartCard>

        <ChartCard
          id="tickets" title="Billets de support" subtitle="Créés par mois · 12 mois"
          to="/dashboard/billets-par-mois"
          points={ticketsSeries} format={fmtInt} valueLabel="Billets" periodLabel="Mois"
        >
          <MiniColumns points={ticketsSeries} tone="violet" format={fmtInt} />
        </ChartCard>

        <ChartCard
          id="mrr" title="Delta MRR net" subtitle="Hausses moins baisses d'abonnements · 12 mois"
          to="/dashboard/mouvements-abonnements"
          points={mrrSeries} format={fmtMoneyCompact} valueLabel="Delta MRR" periodLabel="Mois"
        >
          <DivergingColumns points={mrrSeries} format={fmtMoneyCompact} />
        </ChartCard>

        {/* Soldes par compte */}
        <div className="card p-3" data-testid="overview-bank-accounts">
          <div className="mb-2 flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="truncate text-[13px] font-semibold text-slate-800">
                <Link to="/dashboard/soldes-bancaires" className="hover:text-brand-700 hover:underline">Soldes par compte</Link>
              </h3>
              <p className="truncate text-[11px] text-slate-400">QuickBooks · converti en CAD</p>
            </div>
          </div>
          {bankError ? (
            <p className="text-xs text-rose-600">Indisponible : {bankError}</p>
          ) : !bankRows.length ? (
            <EmptyPlot label="Chargement des comptes…" />
          ) : (
            <div className="max-h-[210px] overflow-y-auto">
              <table className="w-full text-xs">
                {[
                  { label: 'Comptes bancaires', rows: banks, total: bank?.totals?.bank },
                  { label: 'Cartes & marges', rows: cards, total: bank?.totals?.credit_card },
                ].map(g => g.rows.length ? (
                  <tbody key={g.label}>
                    <tr className="bg-slate-50 text-[11px] font-semibold text-slate-700">
                      <td className="px-2 py-1" colSpan={2}>{g.label}</td>
                    </tr>
                    {g.rows.map(a => (
                      <tr key={a.id} className="border-b border-slate-100 text-slate-600">
                        <td className="truncate px-2 py-1">{a.name}</td>
                        <td className="whitespace-nowrap px-2 py-1 text-right tabular-nums">{fmtMoney(a.balance_cad ?? a.balance)}</td>
                      </tr>
                    ))}
                    <tr className="border-b border-slate-200 text-[11px] font-medium text-slate-700">
                      <td className="px-2 py-1">Sous-total</td>
                      <td className="whitespace-nowrap px-2 py-1 text-right tabular-nums">{fmtMoney(g.total || 0)}</td>
                    </tr>
                  </tbody>
                ) : null)}
                <tfoot>
                  <tr className="font-semibold text-slate-900">
                    <td className="px-2 py-1">Trésorerie nette</td>
                    <td className="whitespace-nowrap px-2 py-1 text-right tabular-nums">{fmtMoney(treasury || 0)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>

        {/* Âge des comptes clients */}
        <div className="card p-3" data-testid="overview-aging">
          <div className="mb-2">
            <h3 className="truncate text-[13px] font-semibold text-slate-800">
              <Link to="/factures" className="hover:text-brand-700 hover:underline">Âge des comptes clients</Link>
            </h3>
            <p className="truncate text-[11px] text-slate-400">Soldes dus par tranche de retard</p>
          </div>
          {!aging ? <EmptyPlot label="Chargement…" /> : (
            <div className="space-y-1">
              {aging.buckets.map((b, i) => {
                const max = Math.max(...aging.buckets.map(x => x.total), 1)
                const ramp = ['bg-rose-200', 'bg-rose-300', 'bg-rose-400', 'bg-rose-600'][i] || 'bg-rose-600'
                return (
                  <div key={b.key} className="flex items-center gap-2 text-[11px]">
                    <span className="w-[68px] shrink-0 text-slate-500">{b.label}</span>
                    <div className="h-2.5 flex-1 overflow-hidden rounded-sm bg-slate-100">
                      <div className={`h-full ${ramp}`} style={{ width: `${(b.total / max) * 100}%` }} />
                    </div>
                    <span className="w-[74px] shrink-0 text-right tabular-nums text-slate-700">{fmtMoney(b.total)}</span>
                  </div>
                )
              })}
              <div className="mt-2 border-t border-slate-200 pt-2">
                <p className="mb-1 text-[11px] text-slate-500">Principaux comptes</p>
                {!(aging.companies || []).length ? (
                  <p className="text-[11px] text-slate-400">Aucun solde en souffrance 🎉</p>
                ) : (
                  <ul className="space-y-0.5">
                    {aging.companies.slice(0, 6).map((c, i) => (
                      <li key={c.company_id || i} className="flex items-baseline justify-between gap-2 text-[11px]">
                        <span className="truncate">
                          {c.company_id
                            ? <Link to={`/companies/${c.company_id}`} className="text-brand-600 hover:underline">{c.company_name}</Link>
                            : <span className="text-slate-600">{c.company_name}</span>}
                        </span>
                        <span className="shrink-0 tabular-nums text-slate-600">{fmtMoney(c.total)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

export default DashboardOverview
