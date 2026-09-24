// Serres à conquérir — annuaire public des Producteurs en serre du Québec.
//
// Leur page « Trouver un producteur membre » s'appuie sur un localisateur
// WordPress dont la recherche répond en JSON : nom, adresse, coordonnées,
// téléphone, courriel, site. Public, sans clé. La réponse est plafonnée à 50
// résultats par requête : on balaie donc le Québec depuis plusieurs centres et
// on dédoublonne sur l'identifiant de l'annuaire.
//
// Une ferme déjà connue de l'ERP n'a pas à réapparaître comme « potentiel » :
// elle est appariée à sa fiche (nom normalisé, ou coordonnées à moins de 300 m)
// et retirée de la couche. L'appariement est refait à chaque rafraîchissement,
// donc créer la fiche plus tard suffit à faire disparaître le point.
import crypto from 'node:crypto'
import db from '../db/database.js'

const SEARCH_URL = 'https://www.serres.quebec/wp-admin/admin-ajax.php'
const SOURCE = 'serres.quebec'
const TIMEOUT_MS = 30000

// Centres de balayage : les régions agricoles du Québec, rayon 500 km.
const SWEEP = [
  [45.50, -73.60], [46.80, -71.20], [48.40, -71.05], [45.40, -71.90],
  [46.35, -72.55], [48.45, -68.52], [47.35, -79.43], [45.60, -75.50],
  [49.20, -68.15], [47.50, -70.10], [45.20, -74.10], [46.10, -70.70],
  [48.80, -64.50], [45.90, -73.00], [46.60, -75.00],
]

const MATCH_METERS = 300

// Mots qui ne distinguent personne : formes juridiques, articles, et le
// vocabulaire du métier — la moitié des fermes s'appellent « Les Serres X ».
const NOISE = new Set([
  'inc', 'ltee', 'ltd', 'limitee', 'enr', 'senc', 'sencrl', 'cie', 'co',
  'la', 'le', 'les', 'du', 'de', 'des', 'd', 'l', 'en', 'et', 'a', 'au', 'aux',
  'serre', 'serres', 'ferme', 'fermes', 'jardin', 'jardins', 'pepiniere',
  'pepinieres', 'production', 'productions', 'horticole', 'horticoles',
  'entreprise', 'entreprises', 'groupe', 'quebec',
  'canada', 'freres', 'frere', 'fils', 'soeurs', 'et al',
])

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&rsquo;|&lsquo;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** Les mots distinctifs d'une raison sociale. */
function nameTokens(s) {
  return new Set(
    decodeEntities(s)
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(w => w && !NOISE.has(w)),
  )
}

// Un mot en trop qui ne prouve rien : un numéro d'entreprise, une initiale.
const forgivable = (w) => /^\d+$/.test(w) || w.length <= 3

/**
 * Deux raisons sociales désignent-elles la même ferme ? Les mots distinctifs
 * doivent coïncider : « Les Serres Sagami inc. » et « Sagami » oui, « La Terre »
 * et « La Terre d'en haut » non.
 */
function sameBusinessName(a, b) {
  if (!a.size || !b.size) return false
  const [small, big] = a.size <= b.size ? [a, b] : [b, a]
  const subset = [...small].every(w => big.has(w))

  if (subset) {
    // Mêmes mots, aux numéros d'entreprise et initiales près.
    if ([...big].every(w => small.has(w) || forgivable(w))) return true
    // « Ferme Onésime Pouliot » dans « Ferme Onésime Pouliot – AgriPlant … » :
    // deux mots propres partagés ne sont pas une coïncidence. Un seul, si —
    // « La Terre » n'est pas « La Terre d'en haut ».
    if ([...small].filter(w => w.length >= 5).length >= 2) return true
  }

  // Même nom, coupé autrement : « Explora-Fruits » / « Explorafruits »,
  // « Laval Micro-Cultures » / « Laval MicroCulture ».
  const glue = (set) => [...set].map(w => w.replace(/s$/, '')).join('')
  return glue(a) === glue(b)
}

/** Distance approximative en mètres — suffisant pour un rayon de 300 m. */
function metersBetween(aLat, aLng, bLat, bLng) {
  const dLat = (aLat - bLat) * 111320
  const dLng = (aLng - bLng) * 111320 * Math.cos((aLat * Math.PI) / 180)
  return Math.hypot(dLat, dLng)
}

async function searchAround(lat, lng) {
  const params = new URLSearchParams({
    action: 'store_search', lat: String(lat), lng: String(lng),
    max_results: '50', search_radius: '500', autoload: '1',
  })
  const r = await fetch(`${SEARCH_URL}?${params}`, {
    headers: { 'User-Agent': 'Orisha-ERP/1.0 (+https://orisha.io)' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!r.ok) throw new Error(`serres.quebec HTTP ${r.status}`)
  const json = await r.json()
  return Array.isArray(json) ? json : []
}

/** Balaie l'annuaire et rend une entrée par ferme, dédoublonnée. */
export async function fetchDirectory() {
  const byId = new Map()
  let failures = 0
  for (const [lat, lng] of SWEEP) {
    try {
      for (const row of await searchAround(lat, lng)) {
        if (row?.id) byId.set(String(row.id), row)
      }
    } catch {
      failures++
    }
  }
  if (!byId.size && failures) throw new Error('Annuaire des Producteurs en serre injoignable')
  return [...byId.values()]
}

/**
 * Cherche la fiche ERP correspondant à une ferme de l'annuaire.
 * @returns {{id:string, reason:string}|null}
 */
function findCompany(entry, companies) {
  const tokens = nameTokens(entry.store)
  const byName = companies.find(c => sameBusinessName(tokens, c.tokens))
  if (byName) return { id: byName.id, reason: 'nom' }
  const lat = Number(entry.lat)
  const lng = Number(entry.lng)
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    const near = companies.find(c => c.lat != null && metersBetween(lat, lng, c.lat, c.lng) < MATCH_METERS)
    if (near) return { id: near.id, reason: 'adresse' }
  }
  return null
}

const UPSERT = `
  INSERT INTO greenhouse_leads
    (id, source, external_id, name, address, city, province, postal_code, country,
     phone, email, website, latitude, longitude, matched_company_id, match_reason, refreshed_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT(source, external_id) DO UPDATE SET
    name = excluded.name, address = excluded.address, city = excluded.city,
    province = excluded.province, postal_code = excluded.postal_code,
    phone = excluded.phone, email = excluded.email, website = excluded.website,
    latitude = excluded.latitude, longitude = excluded.longitude,
    matched_company_id = excluded.matched_company_id, match_reason = excluded.match_reason,
    refreshed_at = excluded.refreshed_at`

/**
 * Rafraîchit la couche « potentiel » : relecture de l'annuaire, appariement aux
 * entreprises de l'ERP, écriture. Idempotent.
 */
export async function refreshGreenhouseLeads() {
  const entries = await fetchDirectory()
  const companies = db.prepare(
    `SELECT id, name, latitude, longitude FROM companies WHERE deleted_at IS NULL`
  ).all().map(c => ({ id: c.id, tokens: nameTokens(c.name), lat: c.latitude, lng: c.longitude }))

  const upsert = db.prepare(UPSERT)
  let matched = 0
  const run = db.transaction(() => {
    for (const e of entries) {
      const hit = findCompany(e, companies)
      if (hit) matched++
      const lat = Number(e.lat)
      const lng = Number(e.lng)
      upsert.run(
        crypto.createHash('sha1').update(`${SOURCE}:${e.id}`).digest('hex').slice(0, 16),
        SOURCE, String(e.id), decodeEntities(e.store) || 'Sans nom',
        [e.address, e.address2].filter(Boolean).join(', ') || null,
        e.city || null, e.state || null, e.zip || null, e.country || null,
        e.phone || null, e.email || null, e.url || null,
        Number.isFinite(lat) ? lat : null, Number.isFinite(lng) ? lng : null,
        hit?.id || null, hit?.reason || null,
      )
    }
  })
  run()
  return { fetched: entries.length, matched, new: entries.length - matched }
}

/** Les fermes de l'annuaire qui ne sont pas encore des fiches maison. */
export function listUnmatchedLeads() {
  return db.prepare(
    `SELECT id, name, address, city, province, postal_code, phone, email, website,
            latitude AS lat, longitude AS lng, source
       FROM greenhouse_leads
      WHERE matched_company_id IS NULL AND latitude IS NOT NULL AND longitude IS NOT NULL`
  ).all()
}
