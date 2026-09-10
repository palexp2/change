import db from '../db/database.js'
import { RETURN_COMPANY_SQL } from './returnCompany.js'

// Résout l'adresse du CLIENT pour un retour donné. Source unique : la FICHE
// ENTREPRISE du retour — on propose TOUTES ses adresses (facturation,
// livraison, ferme…), chacune étiquetée de son type, et l'utilisateur choisit.
// Les anciennes sources (adresse de l'envoi, de la commande, du contact) ne
// sont plus consultées : elles produisaient un libellé de provenance
// (« adresse du contact du retour ») sans dire de quel type d'adresse il
// s'agissait, et masquaient les autres adresses de l'entreprise.
// Le retour ne porte plus de colonne `company_id` codée en dur (droppée par la
// migration 037, comme `contact`) : son entreprise se déduit de ses articles,
// de son champ « Entreprise », puis du numéro de série
// (services/returnCompany.js). Un retour sans aucune de ces sources n'a pas
// d'adresse proposée — elle se choisit à la main.
// ⚠️ `adresses` n'a pas de colonne deleted_at (absente du schéma) — ne pas y filtrer.
// ⚠️ Construit à CHAQUE appel : la colonne du champ « Entreprise » se résout à
// l'exécution, un SQL figé à l'import raterait un champ ajouté depuis.
const companyAddressesSql = () => `
  SELECT a.* FROM returns r
    JOIN adresses a ON a.company_id = ${RETURN_COMPANY_SQL('@rid')}
    WHERE r.id = @rid
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
  const rows = db.prepare(companyAddressesSql()).all({ rid: returnId })
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
  const companySql = RETURN_COMPANY_SQL('@rid')
  const ret = db.prepare(`
    SELECT r.id, ${companySql} AS company_id,
           co.name AS company_name, co.email AS company_email
    FROM returns r
    LEFT JOIN companies co ON co.id = ${companySql}
    WHERE r.id = @rid
  `).get({ rid: returnId })
  if (!ret) return null

  const { address, candidates } = resolveReturnAddressContext(returnId, overrideAddressId)
  if (!address) return { ret, address: null, candidates, ctx: null }

  // Le contact de l'ADRESSE est devenu le seul contact d'un retour (la colonne
  // `returns.contact` a été droppée) : sa langue sert aussi aux documents.
  const contact = address.contact_id
    ? db.prepare('SELECT first_name, last_name, email, phone, mobile, langue FROM contacts WHERE id = ?').get(address.contact_id)
    : null

  const ctx = {
    company_id: ret.company_id,
    company_name: ret.company_name,
    company_email: ret.company_email,
    address_id: address.id,
    address_line1: address.line1,
    address_city: address.city,
    address_province: address.province,
    address_postal_code: address.postal_code,
    address_country: address.country,
    address_contact_id: address.contact_id || null,
    address_contact_first_name: contact?.first_name || null,
    address_contact_last_name: contact?.last_name || null,
    address_contact_email: contact?.email || null,
    address_contact_phone: contact?.phone || null,
    address_contact_mobile: contact?.mobile || null,
    address_contact_langue: contact?.langue || null,
  }

  return { ret, address, candidates, ctx }
}
