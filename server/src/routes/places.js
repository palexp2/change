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
    fields: 'formatted_address,geometry',
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
    // Normalise au format {latitude, longitude} pour rester compatible avec
    // d'éventuels consommateurs qui auraient été câblés sur la version New.
    res.json({
      formatted_address: result.formatted_address || '',
      location: loc ? { latitude: loc.lat, longitude: loc.lng } : null,
    })
  } catch (err) {
    console.error('Places details proxy error', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

export default router
