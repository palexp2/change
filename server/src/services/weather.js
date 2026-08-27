// Météo au site — observations horaires de la station la plus proche.
//
// Flux **entrant, lecture seule** : aucune donnée n'est écrite ici.
//
// Deux fournisseurs, tous deux gratuits et sans clé :
//  - Canada  : GeoMet d'Environnement et Changement climatique Canada
//              (api.weather.gc.ca). On combine deux collections :
//                * `swob-realtime`  — observations temps réel (quelques minutes
//                  de délai) mais purgées après ~1 mois ;
//                * `climate-hourly` — archive horaire officielle, complète mais
//                  publiée avec ~24-36 h de retard.
//              Les deux se recouvrent : swob comble la queue récente que
//              climate-hourly n'a pas encore publiée, climate-hourly couvre
//              tout l'historique. Les stations sont trouvées via
//              `swob-stations` (puis `climate-stations` en repli).
//  - États-Unis : National Weather Service (api.weather.gov).
//
// Cache mémoire 30 min, y compris pour les résultats vides (évite de marteler
// l'API amont quand une entreprise est hors couverture).

const GEOMET = 'https://api.weather.gc.ca/collections'
const NWS = 'https://api.weather.gov'
// api.weather.gov exige un User-Agent identifiant l'appelant.
const NWS_UA = 'ERP-Orisha (charles@orisha.io)'

const CACHE_TTL_MS = 30 * 60 * 1000
const FETCH_TIMEOUT_MS = 15000
const WINDOW_HOURS = 72

const cache = new Map()

function cacheGet(key) {
  const hit = cache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(key); return null }
  return hit.value
}

function cacheSet(key, value) {
  // Garde-fou mémoire : le cache ne sert qu'à absorber les rafales de consultation.
  if (cache.size > 500) cache.clear()
  cache.set(key, { at: Date.now(), value })
  return value
}

export function _clearWeatherCache() { cache.clear() }

async function fetchJson(url, headers = {}) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    const err = new Error(`HTTP ${r.status} sur ${url.split('?')[0]} — ${body.slice(0, 160)}`)
    err.status = r.status
    throw err
  }
  return r.json()
}

export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371
  const toRad = d => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}

const US_TOKENS = new Set(['us', 'usa', 'u.s.', 'u.s.a.', 'united states',
  'united states of america', 'etats-unis', 'états-unis', 'etats unis'])
const US_STATES = new Set(['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI',
  'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT',
  'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD',
  'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC'])

// `companies.country` vaut 'Canada' par défaut pour **toutes** les entreprises,
// y compris américaines : on ne peut pas s'y fier seul. En pratique la colonne
// `address` contient l'adresse formatée par Google, qui se termine par le pays
// (« …, Columbus, OH 43202, USA »). On lit donc dans l'ordre : fin d'adresse,
// puis colonne pays, puis code d'état. Aucun code de province canadienne ne
// collisionne avec un code d'état américain.
export function detectCountry({ country, province, address } = {}) {
  const addr = String(address || '').trim()
  if (/,\s*(usa|u\.s\.a\.|united states(\s+of\s+america)?)\.?$/i.test(addr)) return 'US'
  if (/,\s*canada\.?$/i.test(addr)) return 'CA'
  if (US_TOKENS.has(String(country || '').trim().toLowerCase())) return 'US'
  const p = String(province || '').trim().toUpperCase()
  if (p.length === 2 && US_STATES.has(p)) return 'US'
  return 'CA'
}

// ── Découpage horaire ────────────────────────────────────────────────────────
// Les observations brutes arrivent à des minutes arbitraires (swob = ~1/min,
// NWS = ~1/h mais à :53). On les range dans le seau de l'heure UTC la plus
// proche et on garde, par seau, l'observation la plus proche de l'heure pile.

function hourBucket(dateMs) {
  return new Date(Math.round(dateMs / 3600000) * 3600000).toISOString()
}

function pushObs(map, isoTime, values) {
  const ms = Date.parse(isoTime)
  if (!Number.isFinite(ms)) return
  const bucket = hourBucket(ms)
  const offset = Math.abs(ms - Date.parse(bucket))
  const prev = map.get(bucket)
  if (prev && prev.offset <= offset) return
  map.set(bucket, { offset, ...values })
}

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

// ── Canada — GeoMet ──────────────────────────────────────────────────────────

async function nearestSwobStation(lat, lng) {
  for (const span of [0.6, 1.5, 3]) {
    const bbox = [lng - span, lat - span, lng + span, lat + span].join(',')
    let json
    try {
      json = await fetchJson(`${GEOMET}/swob-stations/items?bbox=${bbox}&limit=200&f=json`)
    } catch { return null }
    const feats = (json.features || []).filter(f => f?.geometry?.coordinates && f?.properties?.msc_id)
    if (!feats.length) continue
    let best = null
    for (const f of feats) {
      const [flng, flat] = f.geometry.coordinates
      const d = haversineKm(lat, lng, flat, flng)
      if (!best || d < best.distance_km) {
        best = { id: f.properties.msc_id, name: f.properties.name || f.properties.msc_id, distance_km: d }
      }
    }
    if (best) return best
  }
  return null
}

async function nearestClimateStation(lat, lng) {
  for (const span of [0.6, 1.5, 3]) {
    const bbox = [lng - span, lat - span, lng + span, lat + span].join(',')
    let json
    try {
      json = await fetchJson(`${GEOMET}/climate-stations/items?bbox=${bbox}&limit=300&f=json&HAS_HOURLY_DATA=Y`)
    } catch { return null }
    const feats = (json.features || []).filter(f => f?.geometry?.coordinates && f?.properties?.CLIMATE_IDENTIFIER)
    if (!feats.length) continue
    let best = null
    for (const f of feats) {
      const [flng, flat] = f.geometry.coordinates
      const d = haversineKm(lat, lng, flat, flng)
      if (!best || d < best.distance_km) {
        best = { id: f.properties.CLIMATE_IDENTIFIER, name: f.properties.STATION_NAME || f.properties.CLIMATE_IDENTIFIER, distance_km: d }
      }
    }
    if (best) return best
  }
  return null
}

// Attention : `properties=` sur GeoMet répond 400 « unknown properties specified »
// dès qu'un nom est absent du schéma de la collection. Les noms ci-dessous ont
// été validés contre /collections/swob-realtime/queryables — ne pas en inventer.
const SWOB_PROPS = ['date_tm-value', 'air_temp',
  'avg_wnd_spd_10m_pst1hr', 'avg_wnd_spd_10m_pst10mts', 'avg_wnd_spd_10m_pst1mt',
  'pcpn_amt_pst1hr', 'pcpn_amt_snc_top_of_hr'].join(',')

async function fetchSwob(mscId, startIso, endIso, map) {
  const url = `${GEOMET}/swob-realtime/items?msc_id-value=${encodeURIComponent(mscId)}`
    + `&datetime=${startIso}/${endIso}&limit=2500&f=json&properties=${SWOB_PROPS}`
  const json = await fetchJson(url)
  for (const f of json.features || []) {
    const p = f.properties || {}
    pushObs(map, p['date_tm-value'], {
      temp_c: numOrNull(p.air_temp),
      wind_kph: numOrNull(p['avg_wnd_spd_10m_pst1hr'])
        ?? numOrNull(p['avg_wnd_spd_10m_pst10mts'])
        ?? numOrNull(p['avg_wnd_spd_10m_pst1mt']),
      precip_mm: numOrNull(p['pcpn_amt_pst1hr']) ?? numOrNull(p['pcpn_amt_snc_top_of_hr']),
    })
  }
}

async function fetchClimateHourly(climateId, startIso, endIso, map) {
  // Le paramètre `datetime` de climate-hourly filtre sur LOCAL_DATE (heure locale
  // de la station, sans fuseau). On élargit de ±12 h puis on refiltre sur
  // UTC_DATE, seule valeur fiable pour comparer avec le reste de l'ERP.
  const pad = 12 * 3600000
  const from = new Date(Date.parse(startIso) - pad).toISOString()
  const to = new Date(Date.parse(endIso) + pad).toISOString()
  const props = 'UTC_DATE,TEMP,WIND_SPEED,PRECIP_AMOUNT'
  const url = `${GEOMET}/climate-hourly/items?CLIMATE_IDENTIFIER=${encodeURIComponent(climateId)}`
    + `&datetime=${from}/${to}&limit=200&f=json&properties=${props}`
  const json = await fetchJson(url)
  const startMs = Date.parse(startIso)
  const endMs = Date.parse(endIso)
  for (const f of json.features || []) {
    const p = f.properties || {}
    // UTC_DATE arrive sans suffixe Z alors qu'il s'agit bien d'UTC.
    const iso = p.UTC_DATE ? `${String(p.UTC_DATE).replace(' ', 'T')}Z`.replace('ZZ', 'Z') : null
    if (!iso) continue
    const ms = Date.parse(iso)
    if (!Number.isFinite(ms) || ms < startMs || ms > endMs) continue
    pushObs(map, iso, {
      temp_c: numOrNull(p.TEMP),
      wind_kph: numOrNull(p.WIND_SPEED),
      precip_mm: numOrNull(p.PRECIP_AMOUNT),
    })
  }
}

async function fetchCanada(lat, lng, startIso, endIso) {
  const map = new Map()
  let station = await nearestSwobStation(lat, lng)
  if (station) {
    // Le msc_id d'une station swob est aussi son identifiant climatologique.
    const results = await Promise.allSettled([
      fetchClimateHourly(station.id, startIso, endIso, map),
      fetchSwob(station.id, startIso, endIso, map),
    ])
    for (const r of results) {
      if (r.status === 'rejected') console.warn('[weather] GeoMet partiel:', r.reason?.message || r.reason)
    }
  }
  if (!map.size) {
    const fallback = await nearestClimateStation(lat, lng)
    if (fallback) {
      try {
        await fetchClimateHourly(fallback.id, startIso, endIso, map)
        if (map.size) station = fallback
      } catch (err) {
        console.warn('[weather] climate-hourly repli échoué:', err.message)
      }
    }
  }
  return { source: 'geomet', station, map }
}

// ── États-Unis — National Weather Service ────────────────────────────────────

async function fetchUnitedStates(lat, lng, startIso, endIso) {
  const headers = { 'User-Agent': NWS_UA, Accept: 'application/geo+json' }
  const point = await fetchJson(`${NWS}/points/${lat.toFixed(4)},${lng.toFixed(4)}`, headers)
  const stationsUrl = point?.properties?.observationStations
  if (!stationsUrl) return { source: 'nws', station: null, map: new Map() }

  const stations = await fetchJson(stationsUrl, headers)
  const first = (stations.features || [])[0]
  if (!first?.properties?.stationIdentifier) return { source: 'nws', station: null, map: new Map() }

  const coords = first.geometry?.coordinates
  const station = {
    id: first.properties.stationIdentifier,
    name: first.properties.name || first.properties.stationIdentifier,
    distance_km: coords ? haversineKm(lat, lng, coords[1], coords[0]) : null,
  }

  const url = `${NWS}/stations/${encodeURIComponent(station.id)}/observations`
    + `?start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}&limit=500`
  const obs = await fetchJson(url, headers)
  const map = new Map()
  for (const f of obs.features || []) {
    const p = f.properties || {}
    // NWS ne publie pas systématiquement le cumul horaire ; on retombe sur le
    // cumul 3 h divisé par 3 pour garder un ordre de grandeur.
    const hourly = numOrNull(p.precipitationLastHour?.value)
    const last3 = numOrNull(p.precipitationLast3Hours?.value)
    map.set(hourBucket(Date.parse(p.timestamp)), {
      offset: 0,
      temp_c: numOrNull(p.temperature?.value),
      wind_kph: numOrNull(p.windSpeed?.value),
      precip_mm: hourly != null ? hourly : (last3 != null ? last3 / 3 : null),
    })
  }
  return { source: 'nws', station, map }
}

// ── API publique ─────────────────────────────────────────────────────────────

/**
 * Observations horaires des 72 h précédant `endAt` (défaut : maintenant) pour la
 * station la plus proche du point donné. Ne lève jamais : retourne un statut.
 *
 * @returns {Promise<{status:'ok'|'no_data'|'unavailable', source?:string,
 *   station?:{id:string,name:string,distance_km:number|null},
 *   window?:{start:string,end:string},
 *   observations?:Array<{t:string,temp_c:number|null,wind_kph:number|null,precip_mm:number|null}>,
 *   summary?:object, message?:string}>}
 */
export async function getSiteWeather({ lat, lng, countryCode, endAt } = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { status: 'no_data', message: 'Coordonnées invalides' }
  }
  const endMs = Number.isFinite(Date.parse(endAt)) ? Date.parse(endAt) : Date.now()
  // On cale la fenêtre sur l'heure pile pour que le cache soit partagé entre
  // consultations rapprochées du même dossier.
  const end = new Date(Math.ceil(endMs / 3600000) * 3600000)
  const start = new Date(end.getTime() - WINDOW_HOURS * 3600000)
  const us = countryCode === 'US'

  const key = [lat.toFixed(3), lng.toFixed(3), us ? 'us' : 'ca', end.toISOString()].join('|')
  const cached = cacheGet(key)
  if (cached) return cached

  // Le pays déduit de l'adresse peut être faux (colonne `country` non fiable,
  // site frontalier…). Si le fournisseur retenu ne rend rien, on essaie l'autre
  // avant de conclure à l'absence de données.
  const providers = us
    ? [fetchUnitedStates, fetchCanada]
    : [fetchCanada, fetchUnitedStates]

  let result = null
  let lastError = null
  for (const provider of providers) {
    try {
      const r = await provider(lat, lng, start.toISOString(), end.toISOString())
      if (!result) result = r
      if (r.map.size) { result = r; break }
    } catch (err) {
      lastError = err
      console.warn('[weather] échec amont:', err.message)
    }
  }
  if (!result) {
    // Pas de mise en cache d'une panne amont : on retentera au prochain appel.
    console.warn('[weather] aucun fournisseur joignable:', lastError?.message)
    return { status: 'unavailable', message: 'Service météo indisponible' }
  }

  const observations = [...result.map.entries()]
    .map(([t, v]) => ({ t, temp_c: v.temp_c ?? null, wind_kph: v.wind_kph ?? null, precip_mm: v.precip_mm ?? null }))
    .filter(o => o.temp_c !== null || o.wind_kph !== null || o.precip_mm !== null)
    .sort((a, b) => a.t.localeCompare(b.t))

  if (!observations.length) {
    return cacheSet(key, {
      status: 'no_data',
      source: result.source,
      station: result.station || null,
      window: { start: start.toISOString(), end: end.toISOString() },
    })
  }

  const temps = observations.map(o => o.temp_c).filter(v => v !== null)
  const winds = observations.map(o => o.wind_kph).filter(v => v !== null)
  const precip = observations.map(o => o.precip_mm).filter(v => v !== null)

  return cacheSet(key, {
    status: 'ok',
    source: result.source,
    station: result.station || null,
    window: { start: start.toISOString(), end: end.toISOString() },
    observations,
    summary: {
      temp_min: temps.length ? Math.min(...temps) : null,
      temp_max: temps.length ? Math.max(...temps) : null,
      wind_max: winds.length ? Math.max(...winds) : null,
      precip_total: precip.length ? Math.round(precip.reduce((a, b) => a + b, 0) * 10) / 10 : null,
      hours: observations.length,
    },
  })
}

export default { getSiteWeather, detectCountry, haversineKm }
