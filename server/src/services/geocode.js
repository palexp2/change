// Géocodage d'adresse via Google — **Places legacy uniquement**.
//
// La clé GOOGLE_MAPS_API_KEY n'est autorisée ni sur la Geocoding API
// (`maps/api/geocode`) ni sur le Places New (`places.googleapis.com/v1`) : les
// deux répondent « This API key is not authorized to use this service ». Le
// seul endpoint disponible qui rend des coordonnées à partir d'un texte libre
// est `findplacefromtext` du Places legacy. Voir aussi `routes/places.js`.

const FIND_PLACE = 'https://maps.googleapis.com/maps/api/place/findplacefromtext/json'
const TIMEOUT_MS = 12000

// Cache mémoire des échecs : évite de rappeler Google à chaque consultation
// pour une adresse introuvable. Les succès, eux, sont persistés sur la company.
const NEGATIVE_TTL_MS = 30 * 60 * 1000
const negative = new Map()

export function _clearGeocodeCache() { negative.clear() }

/** Assemble une adresse postale exploitable à partir des colonnes d'une company. */
export function buildAddressQuery(company) {
  if (!company) return ''
  const rawAddress = String(company.address || '').trim()
  // `companies.country` vaut 'Canada' par défaut pour tout le monde. Quand
  // l'adresse se termine déjà par un pays, elle fait foi — sinon un site
  // américain partirait chez Google en « …, USA, Canada ».
  const country = /,\s*(canada|usa|u\.s\.a\.|united states(\s+of\s+america)?)\.?$/i.test(rawAddress)
    ? ''
    : company.country

  const parts = [rawAddress, company.city, company.province, country]
    .map(v => String(v || '').trim())
    .filter(Boolean)
    // `address` contient souvent déjà l'adresse complète formatée par Google
    // (« …, Québec, QC G1V 0B3, Canada ») : on ne réajoute pas ce qu'elle contient.
    .filter((v, i, arr) => i === 0 || !new RegExp(`(^|,\\s*)${escapeRe(v)}\\b`, 'i').test(arr[0]))
  // Une ville seule suffit à situer un site ; un pays seul, non.
  const hasPlace = String(company.address || '').trim() || String(company.city || '').trim()
  return hasPlace ? parts.join(', ') : ''
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * @returns {Promise<{lat:number,lng:number,formatted_address:string}|null>}
 *   `null` si l'adresse est introuvable ; lève si la clé manque ou si Google
 *   répond en erreur (le caller décide quoi en faire).
 */
export async function geocodeAddress(query) {
  const key = process.env.GOOGLE_MAPS_API_KEY
  if (!key) {
    const err = new Error('GOOGLE_MAPS_API_KEY not configured')
    err.code = 'NO_KEY'
    throw err
  }
  const q = String(query || '').trim()
  if (!q) return null

  const cached = negative.get(q)
  if (cached && Date.now() - cached < NEGATIVE_TTL_MS) return null

  const params = new URLSearchParams({
    input: q,
    inputtype: 'textquery',
    fields: 'geometry,formatted_address',
    key,
  })
  const r = await fetch(`${FIND_PLACE}?${params.toString()}`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!r.ok) throw new Error(`Places findplacefromtext HTTP ${r.status}`)
  const json = await r.json()

  if (json.status === 'ZERO_RESULTS' || !(json.candidates || []).length) {
    negative.set(q, Date.now())
    return null
  }
  if (json.status !== 'OK') {
    throw new Error(json.error_message || json.status || 'Places API error')
  }

  const c = json.candidates[0]
  const loc = c?.geometry?.location
  if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) {
    negative.set(q, Date.now())
    return null
  }
  return { lat: loc.lat, lng: loc.lng, formatted_address: c.formatted_address || q }
}

export default { geocodeAddress, buildAddressQuery }
