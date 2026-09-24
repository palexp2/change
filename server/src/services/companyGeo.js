// Coordonnées d'une entreprise — d'où elles viennent, dans l'ordre.
//
// 1. `companies.latitude/longitude` quand elles sont déjà là.
// 2. La colonne héritée `companies.geocode` : Airtable y a stocké, pour 400+
//    fiches, le résultat de SON géocodage — un blob « 🔵 <base64 JSON> » qui
//    contient déjà lat/lng et l'adresse formatée. C'est gratuit et instantané,
//    on le lit avant de penser à appeler Google.
// 3. Google (Places legacy, via services/geocode.js) sur la meilleure adresse
//    disponible.
//
// Les colonnes `address`/`city` du cœur sont quasi vides dans cette base : les
// adresses vivent dans les colonnes héritées d'Airtable (adresse de la ferme,
// puis adresse de facturation). L'ordre suit la réalité du terrain : un
// contrôleur est installé à la ferme, pas au bureau du comptable.
import db from '../db/database.js'
import { geocodeAddress, buildAddressQuery } from './geocode.js'

export const ADDRESS_COLUMNS = [
  'adresse_de_la_ferme_pour_google_map',
  'adresse_de_facturation',
]

/** Décode le blob hérité d'Airtable. `null` si illisible ou sans coordonnées. */
export function decodeAirtableGeocode(raw) {
  const s = String(raw || '').trim()
  if (!s) return null
  // Le blob est préfixé d'un émoji de statut (« 🔵 ») : on repart au premier
  // caractère base64.
  const b64 = s.replace(/^[^A-Za-z0-9+/=]*/, '')
  if (!b64) return null
  try {
    const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))
    const lat = json?.o?.lat
    const lng = json?.o?.lng
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
    return { lat, lng, formatted_address: json?.o?.formattedAddress || '' }
  } catch {
    return null
  }
}

/** La meilleure adresse postale connue d'une entreprise, ou '' si aucune. */
export function resolveCompanyAddress(company) {
  const core = buildAddressQuery(company)
  if (core) return core
  for (const col of ADDRESS_COLUMNS) {
    const v = String(company?.[col] || '').trim()
    if (v) return v
  }
  return ''
}

const SET_COORDS = `UPDATE companies
     SET latitude = ?, longitude = ?,
         geocoded_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE id = ?`

/**
 * Recopie les coordonnées déjà calculées par Airtable sur les fiches qui n'en
 * ont pas. Gratuit, idempotent, sans appel réseau.
 * @returns {{filled:number, unreadable:number}}
 */
export function backfillFromAirtable() {
  const rows = db.prepare(
    `SELECT id, geocode FROM companies
      WHERE deleted_at IS NULL AND latitude IS NULL
        AND COALESCE(geocode, '') <> ''`
  ).all()
  const set = db.prepare(SET_COORDS)
  let filled = 0
  let unreadable = 0
  const run = db.transaction(() => {
    for (const r of rows) {
      const hit = decodeAirtableGeocode(r.geocode)
      if (!hit) { unreadable++; continue }
      set.run(hit.lat, hit.lng, r.id)
      filled++
    }
  })
  run()
  return { filled, unreadable }
}

/** Les fiches encore sans coordonnées mais avec une adresse exploitable. */
export function pendingGeocodeCandidates(limit = 25) {
  const cols = ADDRESS_COLUMNS.join(', ')
  return db.prepare(
    `SELECT c.id, c.name, c.address, c.city, c.province, c.country, ${cols},
            (SELECT COUNT(*) FROM orders o WHERE o.company_id = c.id) AS orders_count
       FROM companies c
      WHERE c.deleted_at IS NULL AND c.latitude IS NULL
        AND (COALESCE(c.address, '') <> '' OR COALESCE(c.city, '') <> ''
             OR COALESCE(c.adresse_de_la_ferme_pour_google_map, '') <> ''
             OR COALESCE(c.adresse_de_facturation, '') <> '')
      ORDER BY orders_count DESC, c.name
      LIMIT ?`
  ).all(limit)
}

/**
 * Géocode via Google un lot de fiches sans coordonnées, clients d'abord.
 * @returns {Promise<{located:number, notFound:string[], failed:string|null}>}
 */
export async function geocodeBatch(limit = 25) {
  const set = db.prepare(SET_COORDS)
  const notFound = []
  let located = 0
  let failed = null
  for (const company of pendingGeocodeCandidates(limit)) {
    const query = resolveCompanyAddress(company)
    if (!query) continue
    let hit
    try {
      hit = await geocodeAddress(query)
    } catch (err) {
      // Clé absente ou Google en panne : inutile d'insister sur le reste du lot.
      failed = err.message
      break
    }
    if (!hit) { notFound.push(company.name); continue }
    set.run(hit.lat, hit.lng, company.id)
    located++
  }
  return { located, notFound, failed }
}
