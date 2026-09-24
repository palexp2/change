// Carte des clients (bac à sable « Tests – Antoine »).
//
// Un point = une entreprise située : vert vif quand elle a déjà commandé,
// ambre quand elle est en cours de démarchage, gris quand elle dort dans le
// répertoire. Le fond de carte est sombre en permanence — ce sont les points
// qui doivent briller, pas les routes.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Map as MapIcon, Crosshair, Loader2, Sprout, Satellite } from 'lucide-react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import api from '../lib/api.js'
import { IMAGERY_TILES, IMAGERY_ATTRIB } from '../components/SatelliteView.jsx'
import { Layout } from '../components/Layout.jsx'
import { PageTitle } from '../components/PageTitle.jsx'
import { useToast } from '../contexts/ToastContext.jsx'

// Fond sombre servi sans clé ni compte (Esri World Dark Gray). CartoDB, l'autre
// candidat évident, tamponne désormais « API KEY REQUIRED » sur chaque tuile.
const TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}'
const LABELS = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}'
const ATTRIB = '&copy; Esri, HERE, Garmin, &copy; OpenStreetMap'
// Vue satellite : pour juger une serre — combien de bâtiments, quelle surface.
const IMAGERY_LABELS = 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'

const KINDS = {
  client:    { color: '#34d399', label: 'Clients' },
  chaud:     { color: '#fbbf24', label: 'Opportunités' },
  prospect:  { color: '#64748b', label: 'Répertoire' },
  // Serres repérées dans les annuaires publics et absentes de l'ERP : le
  // terrain qui reste à prendre.
  potentiel: { color: '#a78bfa', label: 'À conquérir' },
}

// Rayon du point : un client qui a commandé dix fois pèse plus qu'un prospect,
// sans écraser la carte pour autant.
function radiusFor(p) {
  if (p.kind !== 'client') return 4
  return Math.min(5 + Math.sqrt(p.orders) * 2.5, 14)
}

export default function ClientMap() {
  const { addToast } = useToast()
  const navigate = useNavigate()
  const holder = useRef(null)
  const map = useRef(null)
  const base = useRef(null)
  const layers = useRef({})
  const [data, setData] = useState({ points: [], coverage: null })
  const [loading, setLoading] = useState(true)
  const [locating, setLocating] = useState(false)
  const [leading, setLeading] = useState(false)
  const [satellite, setSatellite] = useState(false)
  const [hidden, setHidden] = useState({})

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await api.clientMap.points())
    } catch (e) {
      addToast(e.message || 'Chargement impossible', 'error')
    } finally {
      setLoading(false)
    }
  }, [addToast])

  useEffect(() => { load() }, [load])

  // Création de la carte — une seule fois, elle survit aux rafraîchissements.
  useEffect(() => {
    if (map.current || !holder.current) return
    const m = L.map(holder.current, { zoomControl: true, attributionControl: true, worldCopyJump: true })
      .setView([46.8, -71.2], 6)
    // Les noms de lieux voyagent dans une couche séparée chez Esri, pour les
    // deux fonds : on les garde par-dessus le satellite, sinon on ne sait plus
    // où l'on est.
    base.current = {
      plan: L.layerGroup([
        L.tileLayer(TILES, { attribution: ATTRIB, maxZoom: 16 }),
        L.tileLayer(LABELS, { maxZoom: 16, opacity: 0.8 }),
      ]),
      satellite: L.layerGroup([
        L.tileLayer(IMAGERY_TILES, { attribution: IMAGERY_ATTRIB, maxZoom: 19 }),
        L.tileLayer(IMAGERY_LABELS, { maxZoom: 19, opacity: 0.7 }),
      ]),
    }
    base.current.plan.addTo(m)
    map.current = m
    return () => { m.remove(); map.current = null; base.current = null }
  }, [])

  // Bascule plan ↔ satellite sans reconstruire la carte ni les points.
  useEffect(() => {
    const m = map.current
    if (!m || !base.current) return
    const [on, off] = satellite ? ['satellite', 'plan'] : ['plan', 'satellite']
    base.current[off].remove()
    base.current[on].addTo(m)
    // Le satellite monte plus haut que le fond gris : on ne bride plus le zoom.
    m.setMaxZoom(satellite ? 19 : 16)
  }, [satellite])

  // (Re)dessin des points à chaque chargement ou changement de filtre.
  useEffect(() => {
    const m = map.current
    if (!m) return
    Object.values(layers.current).forEach(l => l.remove())
    layers.current = {}

    const groups = {}
    for (const p of data.points) {
      if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue
      const meta = KINDS[p.kind] || KINDS.prospect
      const marker = L.circleMarker([p.lat, p.lng], {
        radius: radiusFor(p),
        color: meta.color,
        weight: p.kind === 'client' ? 2 : 1,
        opacity: 0.9,
        fillColor: meta.color,
        fillOpacity: p.kind === 'client' ? 0.55 : 0.3,
        className: p.kind === 'client' ? 'map-pulse' : '',
      })
      marker.bindTooltip(p.name, { direction: 'top', offset: [0, -4] })
      marker.bindPopup(`
        <div class="map-pop">
          <strong>${escapeHtml(p.name)}</strong>
          <div>${escapeHtml([p.city, p.province].filter(Boolean).join(', '))}</div>
          ${p.orders ? `<div>${p.orders} commande(s)${p.last_order ? ` · ${p.last_order}` : ''}</div>` : ''}
          ${p.phone ? `<div>${escapeHtml(p.phone)}</div>` : ''}
          ${p.email ? `<div><a href="mailto:${escapeHtml(p.email)}">${escapeHtml(p.email)}</a></div>` : ''}
          ${p.website ? `<div><a href="${escapeHtml(p.website)}" target="_blank" rel="noreferrer">Site web</a></div>` : ''}
          ${p.id ? `<a href="/erp/companies/${p.id}" data-company="${p.id}">Ouvrir la fiche</a>` : ''}
        </div>`)
      if (p.id) {
        marker.on('popupopen', (e) => {
          const a = e.popup.getElement()?.querySelector('a[data-company]')
          if (a) a.onclick = (ev) => { ev.preventDefault(); navigate(`/companies/${p.id}`) }
        })
      }
      ;(groups[p.kind] ||= []).push(marker)
    }

    for (const [kind, markers] of Object.entries(groups)) {
      const group = L.layerGroup(markers)
      layers.current[kind] = group
      if (!hidden[kind]) group.addTo(m)
    }

    const shown = Object.entries(groups).filter(([k]) => !hidden[k]).flatMap(([, v]) => v)
    if (shown.length) m.fitBounds(L.featureGroup(shown).getBounds(), { padding: [40, 40], maxZoom: 9 })
  }, [data, hidden, navigate])

  const locate = useCallback(async () => {
    setLocating(true)
    try {
      const r = await api.clientMap.geocode(60)
      const gained = (r.reused || 0) + (r.located || 0)
      addToast(
        r.error ? `Google indisponible — ${gained} situées` : `${gained} entreprise(s) situées, ${r.remaining} restantes`,
        r.error ? 'error' : 'success',
      )
      await load()
    } catch (e) {
      addToast(e.message || 'Échec', 'error')
    } finally {
      setLocating(false)
    }
  }, [addToast, load])

  // Annuaire public des serres : relecture + réappariement aux fiches maison.
  const refreshLeads = useCallback(async () => {
    setLeading(true)
    try {
      const r = await api.clientMap.refreshLeads()
      addToast(`${r.new} serre(s) à conquérir, ${r.matched} déjà chez nous`, 'success')
      await load()
    } catch (e) {
      addToast(e.message || 'Annuaire injoignable', 'error')
    } finally {
      setLeading(false)
    }
  }, [addToast, load])

  const counts = useMemo(() => {
    const c = { client: 0, chaud: 0, prospect: 0, potentiel: 0 }
    for (const p of data.points) c[p.kind] = (c[p.kind] || 0) + 1
    return c
  }, [data.points])

  const cov = data.coverage

  return (
    <Layout>
      <div className="p-6">
        <div className="flex items-start justify-between gap-4 mb-4">
          <PageTitle icon={MapIcon} accent="compta">Carte des clients</PageTitle>
          <div className="flex items-center gap-2 shrink-0">
            {cov && (
              <span className="text-xs text-slate-500" data-testid="map-coverage">
                {cov.clients_located}/{cov.clients} clients situés · {cov.pending} à situer
              </span>
            )}
            <button onClick={() => setSatellite(v => !v)} data-testid="map-satellite"
              title="Vue satellite"
              className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg border ${
                satellite ? 'bg-brand-600 text-white border-brand-600' : 'text-slate-700 bg-white border-slate-200 hover:bg-slate-50'}`}>
              <Satellite className="w-4 h-4" />
            </button>
            <button onClick={refreshLeads} disabled={leading} data-testid="map-leads"
              title="Relire l'annuaire public des serres"
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg disabled:opacity-50">
              {leading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sprout className="w-4 h-4" />}
              Annuaire
            </button>
            <button onClick={locate} disabled={locating} data-testid="map-locate"
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg disabled:opacity-50">
              {locating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Crosshair className="w-4 h-4" />}
              Situer
            </button>
          </div>
        </div>

        <div className="flex items-center gap-3 mb-2 text-xs">
          {Object.entries(KINDS).map(([kind, meta]) => (
            <button key={kind} onClick={() => setHidden(h => ({ ...h, [kind]: !h[kind] }))}
              data-testid={`map-legend-${kind}`}
              className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-slate-200 dark:border-slate-700 ${hidden[kind] ? 'opacity-40' : ''}`}>
              <span className="w-2.5 h-2.5 rounded-full" style={{ background: meta.color }} />
              {meta.label} <span className="text-slate-400">{counts[kind] || 0}</span>
            </button>
          ))}
        </div>

        {/* `relative z-0 isolate` : Leaflet empile ses propres calques jusqu'à
            z-index 1000 et passait par-dessus les menus flottants de la barre
            de gauche. Le conteneur devient son propre contexte d'empilement. */}
        <div ref={holder} data-testid="map-canvas"
          className="relative z-0 isolate rounded-xl overflow-hidden border border-slate-200 dark:border-slate-700 bg-slate-900"
          style={{ height: 'calc(100vh - 220px)' }} />
        {loading && <div className="mt-2 text-xs text-slate-500">Chargement…</div>}
      </div>
    </Layout>
  )
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}
