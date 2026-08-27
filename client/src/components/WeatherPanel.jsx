import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { CloudSun, ChevronDown, ChevronRight } from 'lucide-react'
import api from '../lib/api.js'

// Panneau « Météo au site » — observations horaires des 72 h autour du dossier
// consulté, à la station la plus proche de l'adresse de l'entreprise.
// Source : GeoMet (ECCC) au Canada, National Weather Service aux États-Unis.
//
// Repliable et **chargé à l'ouverture seulement** : la donnée vient d'une API
// tierce, on ne veut pas la solliciter à chaque affichage d'un billet. L'état
// ouvert/fermé est mémorisé pour l'utilisateur qui s'en sert vraiment.

const OPEN_KEY = 'erp_weather_panel_open'

const W = 640
const H = 96
const PAD = { l: 34, r: 10, t: 10, b: 18 }
// Au-delà de 3 h sans mesure on coupe la courbe plutôt que d'interpoler à
// l'aveugle : une station peut être hors service une demi-journée.
const GAP_MS = 3 * 3600000

const fmtTemp = v => (v === null || v === undefined ? '—' : `${v.toFixed(1).replace('.', ',')} °C`)
const fmtNum = (v, unit) => (v === null || v === undefined ? '—' : `${Math.round(v)} ${unit}`)

function fmtHour(iso) {
  return new Date(iso).toLocaleString('fr-CA', { weekday: 'short', hour: '2-digit', minute: '2-digit' })
}

export default function WeatherPanel({ companyId, at, markerLabel = 'Création du billet' }) {
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(OPEN_KEY) === '1' } catch { return false }
  })
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  // Clé du dernier chargement lancé — évite de rappeler l'API à chaque
  // repli/dépli. Un changement d'entreprise ou de dossier change la clé et
  // relance le chargement.
  const fetchedKey = useRef(null)

  const toggle = useCallback(() => {
    setOpen(o => {
      const next = !o
      try { localStorage.setItem(OPEN_KEY, next ? '1' : '0') } catch { /* stockage indisponible */ }
      return next
    })
  }, [])

  useEffect(() => {
    if (!open || !companyId) return
    const key = `${companyId}|${at || ''}`
    if (fetchedKey.current === key) return
    fetchedKey.current = key
    // `alive` plutôt qu'un AbortController : la requête ne doit surtout pas
    // être annulée quand le panneau se replie ou re-rend, sinon elle n'aboutit
    // jamais. Seul le démontage cesse d'appliquer le résultat.
    let alive = true
    setLoading(true)
    setError(null)
    setData(null)
    api.weather.get(companyId, at)
      .then(d => { if (alive) setData(d) })
      .catch(err => {
        if (!alive) return
        fetchedKey.current = null // permet de réessayer en refermant/rouvrant
        setError(err.message || 'Erreur de chargement')
      })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [open, companyId, at])

  const summary = data?.status === 'ok' ? data.summary : null

  return (
    <div className="card overflow-hidden" data-testid="weather-panel">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-slate-50 transition-colors"
        data-testid="weather-panel-toggle"
      >
        {open ? <ChevronDown size={14} className="text-slate-400 flex-shrink-0" />
          : <ChevronRight size={14} className="text-slate-400 flex-shrink-0" />}
        <CloudSun size={15} className="text-slate-400 flex-shrink-0" />
        <span className="text-sm font-medium text-slate-700">Météo au site</span>
        {summary && summary.temp_min !== null && (
          <span className="ml-auto text-xs text-slate-400 tabular-nums">
            {summary.temp_min.toFixed(1).replace('.', ',')} – {fmtTemp(summary.temp_max)}
          </span>
        )}
      </button>

      {open && (
        <div className="border-t border-slate-100 px-4 py-3" data-testid="weather-panel-body">
          {loading && <div className="text-xs text-slate-400 py-4">Chargement des observations…</div>}
          {!loading && error && (
            <WeatherEmpty text={`Impossible de récupérer la météo : ${error}`} />
          )}
          {!loading && !error && data && <WeatherBody data={data} at={at} markerLabel={markerLabel} />}
          {!loading && !error && !data && !companyId && (
            <WeatherEmpty text="Aucune entreprise liée — impossible de situer le site." />
          )}
        </div>
      )}
    </div>
  )
}

function WeatherEmpty({ text }) {
  return <div className="text-xs text-slate-400 py-4" data-testid="weather-empty">{text}</div>
}

function WeatherBody({ data, at, markerLabel }) {
  if (data.status === 'no_address') {
    return <WeatherEmpty text="Aucune adresse sur l'entreprise — ajoutez-en une pour voir la météo du site." />
  }
  if (data.status === 'not_found') {
    return <WeatherEmpty text={`Adresse introuvable : « ${data.address || '—'} ». Vérifiez-la sur la fiche de l'entreprise.`} />
  }
  if (data.status === 'unavailable') {
    return <WeatherEmpty text={data.message || 'Service météo momentanément indisponible.'} />
  }
  if (data.status !== 'ok' || !data.observations?.length) {
    return <WeatherEmpty text="Aucune station météo avec observations récentes à proximité de ce site." />
  }

  const s = data.summary
  return (
    <div>
      <div className="text-xs text-slate-400 mb-2">
        {data.station?.name || 'Station inconnue'}
        {data.station?.distance_km != null && ` · ${data.station.distance_km.toFixed(1).replace('.', ',')} km du site`}
        {' · '}{data.source === 'nws' ? 'National Weather Service' : 'Environnement Canada'}
      </div>

      <Sparkline observations={data.observations} window={data.window} at={at} markerLabel={markerLabel} />

      <div className="flex flex-wrap gap-x-6 gap-y-1 mt-2 text-xs">
        <Stat label="Min" value={fmtTemp(s.temp_min)} />
        <Stat label="Max" value={fmtTemp(s.temp_max)} />
        <Stat label="Vent max" value={fmtNum(s.wind_max, 'km/h')} />
        <Stat label="Précipitations" value={s.precip_total === null ? '—' : `${String(s.precip_total).replace('.', ',')} mm`} />
        <Stat label="Heures mesurées" value={`${s.hours} / 72`} />
      </div>
    </div>
  )
}

function Stat({ label, value }) {
  return (
    <span className="text-slate-500">
      {label} <span className="font-medium text-slate-900 tabular-nums">{value}</span>
    </span>
  )
}

function Sparkline({ observations, window: win, at, markerLabel }) {
  const [hover, setHover] = useState(null)
  const svgRef = useRef(null)

  const geom = useMemo(() => {
    const startMs = Date.parse(win.start)
    const endMs = Date.parse(win.end)
    const pts = observations
      .filter(o => o.temp_c !== null)
      .map(o => ({ ...o, ms: Date.parse(o.t) }))
      .filter(o => Number.isFinite(o.ms))
    if (!pts.length) return null

    const temps = pts.map(p => p.temp_c)
    let lo = Math.min(...temps)
    let hi = Math.max(...temps)
    if (hi - lo < 2) { const mid = (hi + lo) / 2; lo = mid - 1; hi = mid + 1 }
    const padY = (hi - lo) * 0.15
    lo -= padY; hi += padY

    const x = ms => PAD.l + ((ms - startMs) / (endMs - startMs)) * (W - PAD.l - PAD.r)
    const y = t => PAD.t + (1 - (t - lo) / (hi - lo)) * (H - PAD.t - PAD.b)

    // Découpe en segments continus : un trou > GAP_MS interrompt la ligne.
    const segments = []
    let cur = []
    for (let i = 0; i < pts.length; i++) {
      if (i > 0 && pts[i].ms - pts[i - 1].ms > GAP_MS) { segments.push(cur); cur = [] }
      cur.push({ ...pts[i], cx: x(pts[i].ms), cy: y(pts[i].temp_c) })
    }
    if (cur.length) segments.push(cur)

    const atMs = Date.parse(at || '')
    const markerX = Number.isFinite(atMs) && atMs >= startMs && atMs <= endMs ? x(atMs) : null

    return { pts: segments.flat(), segments, lo, hi, x, y, startMs, endMs, markerX, atMs }
  }, [observations, win, at])

  const onMove = useCallback((e) => {
    if (!geom || !svgRef.current) return
    const rect = svgRef.current.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * W
    let best = null
    for (const p of geom.pts) {
      const d = Math.abs(p.cx - px)
      if (!best || d < best.d) best = { d, p }
    }
    setHover(best && best.d < 40 ? best.p : null)
  }, [geom])

  if (!geom) return <WeatherEmpty text="Températures non disponibles pour cette station." />

  const baseline = geom.y(geom.lo)

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-24 select-none"
        preserveAspectRatio="none"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        data-testid="weather-sparkline"
      >
        <defs>
          <linearGradient id="weatherFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" className="text-brand-500" stopColor="currentColor" stopOpacity="0.22" />
            <stop offset="100%" className="text-brand-500" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Bornes min / max */}
        {[geom.hi, geom.lo].map((v, i) => (
          <g key={i}>
            <line x1={PAD.l} x2={W - PAD.r} y1={geom.y(v)} y2={geom.y(v)}
              className="stroke-slate-100" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            <text x={PAD.l - 4} y={geom.y(v) + 3} textAnchor="end"
              className="fill-slate-400" fontSize="9">{Math.round(v)}°</text>
          </g>
        ))}

        {geom.segments.map((seg, i) => (
          <g key={i}>
            {seg.length > 1 && (
              <path
                d={`M${seg[0].cx},${baseline} ${seg.map(p => `L${p.cx},${p.cy}`).join(' ')} L${seg[seg.length - 1].cx},${baseline} Z`}
                fill="url(#weatherFill)"
              />
            )}
            <polyline
              points={seg.map(p => `${p.cx},${p.cy}`).join(' ')}
              fill="none"
              className="stroke-brand-500"
              strokeWidth="1.6"
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
            {seg.length === 1 && <circle cx={seg[0].cx} cy={seg[0].cy} r="2" className="fill-brand-500" />}
          </g>
        ))}

        {/* Repère de création du dossier */}
        {geom.markerX !== null && (
          <g data-testid="weather-marker">
            <line x1={geom.markerX} x2={geom.markerX} y1={PAD.t - 4} y2={H - PAD.b}
              className="stroke-amber-500" strokeWidth="1.2" strokeDasharray="3 2" vectorEffect="non-scaling-stroke" />
            <circle cx={geom.markerX} cy={PAD.t - 4} r="2.5" className="fill-amber-500" />
          </g>
        )}

        {hover && (
          <g>
            <line x1={hover.cx} x2={hover.cx} y1={PAD.t} y2={H - PAD.b}
              className="stroke-slate-300" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            <circle cx={hover.cx} cy={hover.cy} r="3" className="fill-brand-500" />
          </g>
        )}

        {/* Bornes de la fenêtre — masquées côté par côté quand le libellé du
            repère viendrait s'y superposer. */}
        {!(geom.markerX !== null && geom.markerX < PAD.l + 130) && (
          <text x={PAD.l} y={H - 5} className="fill-slate-400" fontSize="9">{fmtHour(win.start)}</text>
        )}
        {!(geom.markerX !== null && geom.markerX > W - PAD.r - 130) && (
          <text x={W - PAD.r} y={H - 5} textAnchor="end" className="fill-slate-400" fontSize="9">{fmtHour(win.end)}</text>
        )}
        {geom.markerX !== null && (
          <text
            x={Math.min(Math.max(geom.markerX, PAD.l + 45), W - PAD.r - 45)}
            y={H - 5}
            textAnchor="middle"
            className="fill-amber-600"
            fontSize="9"
          >
            {markerLabel}
          </text>
        )}
      </svg>

      {hover && (
        <div
          className="pointer-events-none absolute -top-1 px-2 py-1 rounded-md bg-slate-900 text-white text-[11px] whitespace-nowrap shadow-lg"
          style={{ left: `calc(${(hover.cx / W) * 100}% - 60px)` }}
        >
          {fmtHour(hover.t)} · {fmtTemp(hover.temp_c)}
          {hover.wind_kph !== null && ` · ${Math.round(hover.wind_kph)} km/h`}
          {hover.precip_mm ? ` · ${hover.precip_mm} mm` : ''}
        </div>
      )}
    </div>
  )
}
