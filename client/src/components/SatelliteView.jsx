// Vue satellite d'un site — ce que le ciel dit d'une ferme.
//
// Sert à jauger une serre avant de l'appeler : nombre de bâtiments, verre ou
// plastique, agrandissement récent, et surtout la surface, lisible grâce à
// l'échelle posée en bas de la vignette. Imagerie Esri, sans clé ni compte.
//
// Le bouton « Serres » va chercher l'empreinte au sol des bâtiments (relevés
// OpenStreetMap), cadre la vue dessus et annonce la surface totale : c'est elle
// qui dit le calibre d'un client. Sans relevé, il zoome simplement sur le site.
//
// La molette ne zoome qu'après un clic sur la vue : sinon la page ne défile
// plus dès que le curseur passe dessus.
import { useCallback, useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { Scan } from 'lucide-react'
import api from '../lib/api.js'
import ThinkingOrb from './ThinkingOrb'

export const IMAGERY_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
export const IMAGERY_ATTRIB = '&copy; Esri, Maxar, Earthstar Geographics'

// Une surface de serre se lit en pieds carrés dans le métier, en hectares
// au-delà de quelques terrains.
function fmtArea(m2) {
  if (!m2) return ''
  if (m2 >= 10000) return `${(m2 / 10000).toFixed(1)} ha`
  return `${Math.round(m2).toLocaleString('fr-CA')} m²`
}

export default function SatelliteView({ lat, lng, zoom = 16, height = 240, className = '' }) {
  const holder = useRef(null)
  const map = useRef(null)
  const shapes = useRef(null)
  const [scanning, setScanning] = useState(false)
  const [found, setFound] = useState(null)

  useEffect(() => {
    if (!holder.current || !Number.isFinite(lat) || !Number.isFinite(lng)) return
    const m = L.map(holder.current, {
      center: [lat, lng], zoom,
      zoomControl: true, scrollWheelZoom: false, attributionControl: false,
    })
    L.tileLayer(IMAGERY_TILES, { attribution: IMAGERY_ATTRIB, maxZoom: 19 }).addTo(m)
    L.control.scale({ imperial: false, position: 'bottomright' }).addTo(m)
    L.circleMarker([lat, lng], { radius: 7, color: '#34d399', weight: 2, fillOpacity: 0.15 }).addTo(m)
    m.once('click', () => m.scrollWheelZoom.enable())
    map.current = m
    return () => { m.remove(); map.current = null; shapes.current = null }
  }, [lat, lng, zoom])

  const frameGreenhouses = useCallback(async () => {
    const m = map.current
    if (!m) return
    setScanning(true)
    try {
      const r = await api.clientMap.greenhouses(lat, lng)
      shapes.current?.remove()
      if (!r.shapes?.length) {
        setFound({ count: 0, area: 0, kind: 'none' })
        m.setView([lat, lng], 18)
        return
      }
      const isGreenhouse = r.kind === 'greenhouse'
      // featureGroup et non layerGroup : lui seul sait rendre ses limites.
      const layer = L.featureGroup(r.shapes.map(sh => L.polygon(sh.points, {
        color: isGreenhouse ? '#34d399' : '#fbbf24',
        weight: 2, fillOpacity: 0.12,
      }))).addTo(m)
      shapes.current = layer
      m.fitBounds(layer.getBounds(), { padding: [20, 20], maxZoom: 19 })
      setFound({ count: r.count, area: r.area, kind: r.kind })
    } catch {
      setFound({ count: 0, area: 0, kind: 'error' })
    } finally {
      setScanning(false)
    }
  }, [lat, lng])

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null

  return (
    <div className={className}>
      <div ref={holder} data-testid="satellite-view" style={{ height }}
        className="relative z-0 isolate rounded-lg overflow-hidden bg-slate-900" />
      <div className="mt-1.5 flex items-center gap-2 text-xs">
        <button type="button" onClick={frameGreenhouses} disabled={scanning} data-testid="satellite-frame"
          className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-50">
          {scanning ? <ThinkingOrb size={12} ink /> : <Scan size={12} />}
          Serres
        </button>
        {found && (
          <span data-testid="satellite-area" className="text-slate-500">
            {found.kind === 'greenhouse' && `${found.count} serre(s) · ${fmtArea(found.area)}`}
            {found.kind === 'building' && `${found.count} bâtiment(s) · ${fmtArea(found.area)}`}
            {found.kind === 'none' && 'Rien de relevé'}
            {found.kind === 'error' && 'Relevé indisponible'}
          </span>
        )}
      </div>
    </div>
  )
}
