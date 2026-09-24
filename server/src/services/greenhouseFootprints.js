// Empreintes des serres au sol, d'après OpenStreetMap (Overpass).
//
// Sert à cadrer la vue satellite sur les bâtiments plutôt que sur un point
// d'adresse, et à donner une surface : c'est elle qui dit le calibre d'un
// client. Les serres y sont taguées `building=greenhouse` ou
// `landuse=greenhouse_horticulture` ; à défaut on retombe sur les bâtiments
// agricoles du voisinage, mieux que rien pour viser la bonne parcelle.
//
// Overpass est un service public gratuit : on l'appelle avec une identité
// claire, un seul essai, et on garde le résultat en mémoire une journée.
// Les instances publiques d'Overpass répondent 429/504 quand elles sont
// chargées : on en essaie plusieurs avant d'abandonner.
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
]
const TIMEOUT_MS = 40000
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

const cache = new Map()

export function _clearFootprintCache() { cache.clear() }

function buildQuery(lat, lng, radius) {
  const near = `(around:${radius},${lat},${lng})`
  return `[out:json][timeout:30];(
    way${near}["building"="greenhouse"];
    way${near}["landuse"="greenhouse_horticulture"];
    way${near}["building"="farm_auxiliary"];
    way${near}["building"="barn"];
    way${near}["building"="yes"];
  );out geom 300;`
}

/** Aire d'un polygone en m², par la formule du lacet projetée localement. */
function polygonArea(points) {
  if (points.length < 3) return 0
  const lat0 = (points.reduce((s, p) => s + p[0], 0) / points.length) * Math.PI / 180
  const mx = 111320 * Math.cos(lat0)
  const my = 110540
  let sum = 0
  for (let i = 0; i < points.length; i++) {
    const [aLat, aLng] = points[i]
    const [bLat, bLng] = points[(i + 1) % points.length]
    sum += (aLng * mx) * (bLat * my) - (bLng * mx) * (aLat * my)
  }
  return Math.abs(sum) / 2
}

/** Distance du site au point le plus proche d'un polygone, en mètres. */
function distanceTo(lat, lng, points) {
  const mx = 111320 * Math.cos(lat * Math.PI / 180)
  return Math.min(...points.map(([pLat, pLng]) =>
    Math.hypot((pLat - lat) * 110540, (pLng - lng) * mx)))
}

/**
 * @returns {Promise<{shapes:Array<{points:number[][], kind:string, area:number}>,
 *   area:number, count:number, kind:'greenhouse'|'building'|'none'}>}
 */
export async function greenhousesAround(lat, lng, radius = 600) {
  const key = `${lat.toFixed(5)},${lng.toFixed(5)},${radius}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value

  const body = new URLSearchParams({ data: buildQuery(lat, lng, radius) }).toString()
  let json = null
  let lastError = null
  for (const endpoint of ENDPOINTS) {
    try {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Orisha-ERP/1.0 (+https://orisha.io)',
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!r.ok) { lastError = new Error(`Overpass HTTP ${r.status}`); continue }
      json = await r.json()
      break
    } catch (err) {
      lastError = err
    }
  }
  if (!json) throw lastError || new Error('Overpass injoignable')

  const all = []
  for (const el of json.elements || []) {
    const points = (el.geometry || []).map(g => [g.lat, g.lon]).filter(p => Number.isFinite(p[0]))
    if (points.length < 3) continue
    const tags = el.tags || {}
    const isGreenhouse = tags.building === 'greenhouse' || tags.landuse === 'greenhouse_horticulture'
    all.push({ points, kind: isGreenhouse ? 'greenhouse' : 'building', area: polygonArea(points) })
  }

  // Des serres identifiées ? On ignore le reste du bâti : c'est ce qu'on veut
  // cadrer. Sinon on retombe sur le bâti, mais seulement celui qui touche au
  // point : dans un village, tout cadrer revient à ne rien cadrer.
  const greenhouses = all.filter(s => s.kind === 'greenhouse')
  const near = all
    .map(s => ({ ...s, d: distanceTo(lat, lng, s.points) }))
    .filter(s => s.d < 150)
    .sort((a, b) => b.area - a.area)
    .slice(0, 8)
  const shapes = greenhouses.length ? greenhouses : near
  const value = {
    shapes,
    area: Math.round(shapes.reduce((s, x) => s + x.area, 0)),
    count: shapes.length,
    kind: greenhouses.length ? 'greenhouse' : (shapes.length ? 'building' : 'none'),
  }
  cache.set(key, { at: Date.now(), value })
  return value
}
