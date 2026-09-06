import db from '../db/database.js'

// Résout l'adresse du CLIENT pour un retour donné. Source unique : la FICHE
// ENTREPRISE du retour — on propose TOUTES ses adresses (facturation,
// livraison, ferme…), chacune étiquetée de son type, et l'utilisateur choisit.
// Les anciennes sources (adresse de l'envoi, de la commande, du contact) ne
// sont plus consultées : elles produisaient un libellé de provenance
// (« adresse du contact du retour ») sans dire de quel type d'adresse il
// s'agissait, et masquaient les autres adresses de l'entreprise.
// `returns.company_id` est renseigné sur 473 des 476 retours ; pour les rares
// exceptions on retombe sur l'entreprise du contact du retour (colonne
// `returns.contact`, champ personnalisé depuis la migration 027).
// ⚠️ `adresses` n'a pas de colonne deleted_at (absente du schéma) — ne pas y filtrer.
const COMPANY_ADDRESSES_SQL = `
  SELECT a.* FROM returns r
    JOIN adresses a ON a.company_id = COALESCE(
      r.company_id,
      (SELECT ct.company_id FROM contacts ct WHERE ct.id = r.contact)
    )
    WHERE r.id = ?
    ORDER BY (CASE a.address_type
                WHEN 'Livraison' THEN 0
                WHEN 'Ferme' THEN 1
                WHEN 'Facturation' THEN 2
                ELSE 3 END), a.created_at DESC
`

// Libellé affiché à côté de l'adresse : son type, rien de plus.
function addressTypeLabel(row) {
  return row.address_type?.trim() || 'Type inconnu'
}

// Renvoie la meilleure adresse candidate + toutes les adresses de l'entreprise
// (pour le sélecteur côté UI), chacune avec son étiquette de type.
export function resolveReturnAddressContext(returnId, overrideAddressId = null) {
  const rows = db.prepare(COMPANY_ADDRESSES_SQL).all(returnId)
  const candidates = rows
    .filter(r => (r.line1 || r.city || r.postal_code))
    .map(r => ({ ...r, address_label: addressTypeLabel(r) }))

  let chosen = null
  if (overrideAddressId) {
    chosen = candidates.find(a => a.id === overrideAddressId) || null
  }
  if (!chosen) chosen = candidates[0] || null
  return { address: chosen, candidates }
}

// Construit le "ctx" attendu par buildRecipient/buildReturnPayload — mêmes
// clés que getShipmentWithAddress() dans routes/novoxpress.js, pour que
// buildRecipient le consomme sans adaptateur.
export function buildReturnPartyContext(returnId, overrideAddressId = null) {
  const ret = db.prepare(`
    SELECT r.id, r.company_id, r.contact, co.name AS company_name, co.phone AS company_phone, co.email AS company_email
    FROM returns r
    LEFT JOIN companies co ON r.company_id = co.id
    WHERE r.id = ?
  `).get(returnId)
  if (!ret) return null

  const { address, candidates } = resolveReturnAddressContext(returnId, overrideAddressId)
  if (!address) return { ret, address: null, candidates, ctx: null }

  const contact = address.contact_id
    ? db.prepare('SELECT first_name, last_name, email, phone, mobile FROM contacts WHERE id = ?').get(address.contact_id)
    : null

  const ctx = {
    company_name: ret.company_name,
    company_phone: ret.company_phone,
    company_email: ret.company_email,
    address_id: address.id,
    address_line1: address.line1,
    address_city: address.city,
    address_province: address.province,
    address_postal_code: address.postal_code,
    address_country: address.country,
    address_contact_first_name: contact?.first_name || null,
    address_contact_last_name: contact?.last_name || null,
    address_contact_email: contact?.email || null,
    address_contact_phone: contact?.phone || null,
    address_contact_mobile: contact?.mobile || null,
  }

  return { ret, address, candidates, ctx }
}
