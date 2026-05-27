import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

// Proxy vers Google Places API (legacy) — la clé reste en backend, jamais exposée
// au client. Utilisé par le champ Address du qualification call.
//
// On utilise le **legacy** Places API plutôt que le New parce que la clé fournie
// (GOOGLE_MAPS_API_KEY) n'a pas l'autorisation pour le New (PERMISSION_DENIED
// sur places.googleapis.com/v1) mais a accès au legacy maps.googleapis.com/maps/api/place.
//
// Session token : passé en query param par le client pour grouper les requêtes
// autocomplete + details en un seul billing event Google.
const PLACES_BASE = 'https://maps.googleapis.com/maps/api/place'

// Convertit les address_components Google (street_number, route, locality, …)
// en { line1, city, province, postal_code, country } structurés utilisables
// par Stripe customer.address et par computeCanadaTaxes.
// `province` et `country` sont retournés en codes courts (QC, CA) — Google les
// expose via short_name, c'est aussi ce qu'attend Stripe pour address.state/country.
function parseAddressComponents(components) {
  const out = { line1: '', city: '', province: '', postal_code: '', country: '' }
  let streetNumber = ''
  let route = ''
  for (const c of components) {
    const types = c.types || []
    if (types.includes('street_number')) streetNumber = c.long_name || ''
    else if (types.includes('route')) route = c.long_name || ''
    else if (types.includes('locality')) out.city = c.long_name || ''
    else if (!out.city && types.includes('sublocality')) out.city = c.long_name || ''
    else if (!out.city && types.includes('postal_town')) out.city = c.long_name || ''
    else if (types.includes('administrative_area_level_1')) out.province = c.short_name || ''
    else if (types.includes('postal_code')) out.postal_code = c.long_name || ''
    else if (types.includes('country')) out.country = c.short_name || ''
  }
  out.line1 = [streetNumber, route].filter(Boolean).join(' ').trim()
  return out
}

router.get('/autocomplete', async (req, res) => {
  const key = process.env.GOOGLE_MAPS_API_KEY
  if (!key) return res.status(503).json({ error: 'GOOGLE_MAPS_API_KEY not configured' })

  const input = String(req.query.input || '').trim()
  if (!input) return res.json({ predictions: [] })

  const sessionToken = req.query.session_token ? String(req.query.session_token) : ''

  const params = new URLSearchParams({ input, key })
  if (sessionToken) params.set('sessiontoken', sessionToken)

  try {
    const r = await fetch(`${PLACES_BASE}/autocomplete/json?${params.toString()}`)
    if (!r.ok) {
      const text = await r.text()
      console.error('Places autocomplete failed', r.status, text)
      return res.status(502).json({ error: 'Places API error', detail: text.slice(0, 200) })
    }
    const json = await r.json()
    if (json.status && json.status !== 'OK' && json.status !== 'ZERO_RESULTS') {
      console.error('Places autocomplete status', json.status, json.error_message)
      return res.status(502).json({ error: 'Places API error', detail: json.error_message || json.status })
    }
    const predictions = (json.predictions || []).map(p => ({
      place_id: p.place_id,
      description: p.description || '',
    }))
    res.json({ predictions })
  } catch (err) {
    console.error('Places autocomplete proxy error', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

router.get('/details', async (req, res) => {
  const key = process.env.GOOGLE_MAPS_API_KEY
  if (!key) return res.status(503).json({ error: 'GOOGLE_MAPS_API_KEY not configured' })

  const placeId = String(req.query.place_id || '').trim()
  if (!placeId) return res.status(400).json({ error: 'place_id required' })

  const sessionToken = req.query.session_token ? String(req.query.session_token) : ''

  const params = new URLSearchParams({
    place_id: placeId,
    key,
    fields: 'formatted_address,geometry,address_component',
  })
  if (sessionToken) params.set('sessiontoken', sessionToken)

  try {
    const r = await fetch(`${PLACES_BASE}/details/json?${params.toString()}`)
    if (!r.ok) {
      const text = await r.text()
      console.error('Places details failed', r.status, text)
      return res.status(502).json({ error: 'Places API error', detail: text.slice(0, 200) })
    }
    const json = await r.json()
    if (json.status && json.status !== 'OK') {
      console.error('Places details status', json.status, json.error_message)
      return res.status(502).json({ error: 'Places API error', detail: json.error_message || json.status })
    }
    const result = json.result || {}
    const loc = result.geometry && result.geometry.location
    const components = parseAddressComponents(result.address_components || [])
    // Normalise au format {latitude, longitude} pour rester compatible avec
    // d'éventuels consommateurs qui auraient été câblés sur la version New.
    res.json({
      formatted_address: result.formatted_address || '',
      location: loc ? { latitude: loc.lat, longitude: loc.lng } : null,
      components,
    })
  } catch (err) {
    console.error('Places details proxy error', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

export default router
