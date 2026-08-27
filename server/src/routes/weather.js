import { Router } from 'express'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { getSiteWeather, detectCountry } from '../services/weather.js'
import { geocodeAddress, buildAddressQuery } from '../services/geocode.js'

const router = Router()
router.use(requireAuth)

const HOUR = 3600000

// `at` = moment d'intérêt (création du billet). Par défaut la fenêtre couvre
// les 72 dernières heures. Si `at` est plus vieux que ça, la fenêtre glisse
// pour se terminer 12 h après `at` : sinon le repère de création tomberait hors
// du graphique et le panneau ne dirait rien du dossier consulté.
function resolveWindowEnd(at) {
  const ms = Date.parse(String(at || ''))
  if (!Number.isFinite(ms)) return undefined
  const now = Date.now()
  if (ms >= now - 60 * HOUR) return undefined
  return new Date(Math.min(now, ms + 12 * HOUR)).toISOString()
}

// GET /api/weather?companyId=…[&at=ISO]
//
// Météo au site : observations horaires des 72 h précédant `at` (défaut :
// maintenant) à la station la plus proche de l'adresse de l'entreprise.
// Flux entrant, lecture seule — la seule écriture est la mise en cache de
// lat/lng sur la company après géocodage.
//
// Ne renvoie jamais 5xx pour un site simplement non couvert : le front affiche
// un état vide explicite à partir de `status`.
//   ok · no_address · not_found · no_data · unavailable
router.get('/', async (req, res) => {
  const companyId = String(req.query.companyId || '').trim()
  if (!companyId) return res.status(400).json({ error: 'companyId requis' })

  const company = db.prepare(
    `SELECT id, name, address, city, province, country, latitude, longitude
       FROM companies WHERE id = ? AND deleted_at IS NULL`
  ).get(companyId)
  if (!company) return res.status(404).json({ error: 'Company not found' })

  const base = { company: { id: company.id, name: company.name } }

  // `Number(null)` vaut 0 (une coordonnée parfaitement valide au large du
  // Ghana) : il faut tester la nullité avant de convertir.
  let lat = company.latitude == null ? NaN : Number(company.latitude)
  let lng = company.longitude == null ? NaN : Number(company.longitude)

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    const query = buildAddressQuery(company)
    if (!query) {
      return res.json({ ...base, status: 'no_address' })
    }
    let hit
    try {
      hit = await geocodeAddress(query)
    } catch (err) {
      console.warn('[weather] géocodage échoué:', err.message)
      return res.json({ ...base, status: 'unavailable', message: 'Géocodage indisponible', address: query })
    }
    if (!hit) {
      return res.json({ ...base, status: 'not_found', address: query })
    }
    lat = hit.lat
    lng = hit.lng
    // On ne touche pas `updated_at` : le géocodage est un cache technique, pas
    // une modification de la fiche. `geocoded_at` porte la date pour le suivi.
    db.prepare(
      `UPDATE companies SET latitude = ?, longitude = ?,
         geocoded_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`
    ).run(lat, lng, company.id)
  }

  const weather = await getSiteWeather({
    lat,
    lng,
    countryCode: detectCountry(company),
    endAt: resolveWindowEnd(req.query.at),
  })

  res.json({
    ...base,
    ...weather,
    coordinates: { lat, lng },
    address: buildAddressQuery(company),
  })
})

export default router
