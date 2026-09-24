import db from '../db/database.js'
import { newRecordId } from '../utils/recordId.js'

const fields = ['line1', 'city', 'province', 'postal_code', 'country']
const normalized = (address, field) => String(address?.[field] || (field === 'country' ? 'Canada' : '')).trim().toLowerCase()

// Adresse née dans Boréal : son équivalent déjà présent dans Airtable (même
// entreprise, même code postal, même numéro civique), pour que la commande y
// soit liée — Airtable ne connaît pas les adresses créées ici.
const compact = v => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '')
const streetNumber = v => String(v || '').trim().match(/^\d+/)?.[0] || ''
export function airtableTwinAddress(address) {
  if (!address?.id || address.airtable_id || !address.company_id) return address
  const postal = compact(address.postal_code), number = streetNumber(address.line1)
  if (!postal || !number) return address
  const twin = db.prepare('SELECT * FROM adresses WHERE company_id=? AND airtable_id IS NOT NULL AND id<>?').all(address.company_id, address.id)
    .find(a => compact(a.postal_code) === postal && streetNumber(a.line1) === number)
  return twin || address
}

// Retrouver les réponses exactes, sans remplacer l'adresse d'un autre site
// ni modifier une adresse déjà utilisée par une commande antérieure.
export function discoveryAddresses(row, { persist = false } = {}) {
  const candidates = row.company_id
    ? db.prepare('SELECT * FROM adresses WHERE company_id=? ORDER BY created_at DESC, id').all(row.company_id)
    : []
  function resolve(key, type, supplied) {
    const linked = candidates.find(a => a.id === row[key])
    const answer = supplied === undefined
      ? JSON.parse(row[type === 'Ferme' ? 'farm_address_json' : 'shipping_address_json'] || 'null')
      : supplied
    if (linked && (!answer || fields.every(f => normalized(linked, f) === normalized(answer, f)))) return linked
    if (!answer) return row.is_new_site === 'new' ? null : candidates.find(a => a.address_type === type) || null
    if (!answer.line1 || !answer.province) return { ...answer, id: null }
    const match = candidates.find(a => a.address_type === type && fields.every(f => normalized(a, f) === normalized(answer, f)))
    if (match) return match
    if (!persist || !row.company_id) return { ...answer, id: null }
    const address = { ...answer, id: newRecordId(), company_id: row.company_id, address_type: type, country: answer.country || 'Canada' }
    db.prepare('INSERT INTO adresses (id, company_id, address_type, line1, city, province, postal_code, country) VALUES (?,?,?,?,?,?,?,?)')
      .run(address.id, row.company_id, type, ...fields.map(f => address[f] || null))
    candidates.push(address)
    return address
  }
  const farm = resolve('farm_address_id', 'Ferme')
  const shipping = row.shipping_same_as_farm ? farm : resolve('shipping_address_id', 'Livraison')
  if (persist) {
    db.prepare('UPDATE customer_onboarding_responses SET farm_address_id=?, shipping_address_id=? WHERE id=?')
      .run(farm?.id || null, shipping?.id || null, row.id)
  }
  return { farm_address_id: farm?.id || null, shipping_address_id: shipping?.id || null, farm_address: farm, shipping_address: shipping }
}
