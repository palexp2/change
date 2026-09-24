// Carte des clients (page « Tests – Antoine ») — lecture seule, sauf le bouton
// de complétion des coordonnées qui écrit latitude/longitude sur les fiches.
//
// Un point = une entreprise située. Elle est « client » dès qu'une commande lui
// est rattachée, « prospect » sinon : c'est ce qui donne le contraste entre le
// terrain gagné et le terrain à prendre.
import { Router } from 'express'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { backfillFromAirtable, geocodeBatch, pendingGeocodeCandidates } from '../services/companyGeo.js'
import { listUnmatchedLeads, refreshGreenhouseLeads } from '../services/greenhouseLeads.js'
import { greenhousesAround } from '../services/greenhouseFootprints.js'

const router = Router()
router.use(requireAuth)

// Phases du cycle de vie qui valent « prospect chaud » : elles colorent le
// point plus vivement que le reste du répertoire.
const WARM_PHASES = new Set(['Quote Sent', 'Qualified', 'Solution aware', 'Problem aware', 'Lead'])

const POINTS_SQL = `
  SELECT c.id, c.name, c.city, c.province, c.country, c.lifecycle_phase,
         c.latitude AS lat, c.longitude AS lng,
         (SELECT COUNT(*) FROM orders o WHERE o.company_id = c.id) AS orders_count,
         (SELECT MIN(COALESCE(o.date_commande, o.date_de_la_commande))
            FROM orders o WHERE o.company_id = c.id) AS first_order,
         (SELECT MAX(COALESCE(o.date_commande, o.date_de_la_commande))
            FROM orders o WHERE o.company_id = c.id) AS last_order
    FROM companies c
   WHERE c.deleted_at IS NULL AND c.latitude IS NOT NULL AND c.longitude IS NOT NULL`

// GET /api/client-map/points — tous les points situés + l'état de couverture.
router.get('/points', (req, res) => {
  const rows = db.prepare(POINTS_SQL).all()
  const points = rows.map(r => ({
    id: r.id,
    name: r.name,
    city: r.city || '',
    province: r.province || '',
    country: r.country || '',
    lat: r.lat,
    lng: r.lng,
    orders: r.orders_count,
    first_order: (r.first_order || '').slice(0, 10) || null,
    last_order: (r.last_order || '').slice(0, 10) || null,
    kind: r.orders_count > 0 ? 'client' : (WARM_PHASES.has(r.lifecycle_phase) ? 'chaud' : 'prospect'),
  }))

  const coverage = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM companies WHERE deleted_at IS NULL) AS companies,
      (SELECT COUNT(*) FROM companies WHERE deleted_at IS NULL AND latitude IS NOT NULL) AS located,
      (SELECT COUNT(DISTINCT o.company_id) FROM orders o WHERE o.company_id IS NOT NULL) AS clients,
      (SELECT COUNT(DISTINCT o.company_id) FROM orders o
         JOIN companies c ON c.id = o.company_id
        WHERE c.latitude IS NOT NULL) AS clients_located
  `).get()

  // Couche « potentiel » : les serres des annuaires publics qui ne sont pas
  // déjà des fiches maison. Pas d'`id` d'entreprise : le point n'ouvre pas de
  // fiche, il affiche ce qu'on sait de la ferme.
  for (const lead of listUnmatchedLeads()) {
    points.push({
      id: null,
      lead_id: lead.id,
      name: lead.name,
      city: lead.city || '',
      province: lead.province || '',
      country: 'Canada',
      lat: lead.lat,
      lng: lead.lng,
      orders: 0,
      phone: lead.phone || '',
      email: lead.email || '',
      website: lead.website || '',
      source: lead.source,
      kind: 'potentiel',
    })
  }

  res.json({ points, coverage: { ...coverage, pending: pendingGeocodeCandidates(5000).length } })
})

// POST /api/client-map/leads/refresh — relit l'annuaire public des serres et
// réapparie le tout aux fiches de l'ERP.
router.post('/leads/refresh', async (req, res) => {
  try {
    res.json(await refreshGreenhouseLeads())
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

// POST /api/client-map/geocode — complète les coordonnées manquantes.
// D'abord la reprise gratuite des coordonnées héritées d'Airtable, puis un lot
// borné d'appels Google (clients d'abord). Bornée pour rester interactive : on
// reclique tant qu'il reste des fiches.
router.post('/geocode', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.body?.limit) || 50, 1), 200)
  const reuse = backfillFromAirtable()
  const batch = await geocodeBatch(limit)
  res.json({
    reused: reuse.filled,
    located: batch.located,
    not_found: batch.notFound,
    remaining: pendingGeocodeCandidates(5000).length,
    error: batch.failed,
  })
})


// GET /api/client-map/greenhouses?lat=&lng= — empreintes des serres autour d'un
// site, pour cadrer la vue satellite et annoncer une surface.
router.get('/greenhouses', async (req, res) => {
  const lat = Number(req.query.lat)
  const lng = Number(req.query.lng)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: 'lat/lng requis' })
  const radius = Math.min(Math.max(Number(req.query.radius) || 600, 100), 2000)
  try {
    res.json(await greenhousesAround(lat, lng, radius))
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

export default router
