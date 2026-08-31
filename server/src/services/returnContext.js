import db from '../db/database.js'

// Résout l'adresse du CLIENT pour un retour donné, en cascade du plus fiable
// au plus approximatif (le retour n'a pas de address_id propre) :
//   1. l'adresse de l'envoi lié à la commande du retour (là où le colis est parti)
//   2. l'adresse de la commande elle-même (orders.address_id)
//   3. une adresse rattachée au contact du retour
//   4. une adresse rattachée à l'entreprise du retour
// ⚠️ `adresses` n'a pas de colonne deleted_at (absente du schéma) — ne pas y filtrer.
// SQLite n'autorise ORDER BY/LIMIT que sur le dernier SELECT d'un compound
// (UNION ALL) — chaque branche qui doit se limiter à 1 ligne est donc une
// sous-requête indépendante, wrappée dans un SELECT * externe sans son propre
// ORDER BY.
const CASCADE_SQL = `
  SELECT * FROM (
    SELECT a.*, 1 AS src FROM returns r
      JOIN shipments s ON s.order_id = r.order_id
      JOIN adresses a ON a.id = s.address_id
      WHERE r.id = ?
      ORDER BY s.created_at DESC LIMIT 1
  )
  UNION ALL
  SELECT * FROM (
    SELECT a.*, 2 AS src FROM returns r
      JOIN orders o ON o.id = r.order_id
      JOIN adresses a ON a.id = o.address_id
      WHERE r.id = ?
  )
  UNION ALL
  SELECT * FROM (
    SELECT a.*, 3 AS src FROM returns r
      JOIN adresses a ON a.contact_id = r.contact_id
      WHERE r.id = ?
      ORDER BY (CASE WHEN a.address_type = 'Livraison' THEN 0 ELSE 1 END), a.created_at DESC LIMIT 1
  )
  UNION ALL
  SELECT * FROM (
    SELECT a.*, 4 AS src FROM returns r
      JOIN adresses a ON a.company_id = r.company_id
      WHERE r.id = ?
      ORDER BY (CASE WHEN a.address_type = 'Livraison' THEN 0 ELSE 1 END), a.created_at DESC LIMIT 1
  )
`

const CASCADE_LABELS = {
  1: "adresse de l'envoi lié à la commande du retour",
  2: "adresse de la commande du retour",
  3: 'adresse du contact du retour',
  4: "adresse de l'entreprise du retour",
}

// Renvoie la meilleure adresse candidate + toutes les candidates (pour un
// sélecteur d'override côté UI) avec, pour chacune, le niveau de cascade et
// son explication.
export function resolveReturnAddressContext(returnId, overrideAddressId = null) {
  const rows = db.prepare(CASCADE_SQL).all(returnId, returnId, returnId, returnId)
  const candidates = rows.map(r => ({ ...r, cascade_label: CASCADE_LABELS[r.src] }))

  let chosen = null
  if (overrideAddressId) {
    chosen = candidates.find(a => a.id === overrideAddressId) || null
  }
  if (!chosen) {
    chosen = candidates.sort((a, b) => a.src - b.src)[0] || null
  }
  return { address: chosen, candidates }
}

// Construit le "ctx" attendu par buildRecipient/buildReturnPayload — mêmes
// clés que getShipmentWithAddress() dans routes/novoxpress.js, pour que
// buildRecipient le consomme sans adaptateur.
export function buildReturnPartyContext(returnId, overrideAddressId = null) {
  const ret = db.prepare(`
    SELECT r.id, r.company_id, r.contact_id, co.name AS company_name, co.phone AS company_phone, co.email AS company_email
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
