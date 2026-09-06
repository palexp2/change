/**
 * 016 — le champ « Adresse de livraison » des envois devient bidirectionnel.
 *
 * Suite immédiate de 015 (« Commande »), même cause et même remède :
 * `shipments.address_id` ↔ « Adresse de livraison » est un linked record, que le
 * write-back refusait par principe. La colonne rejoint `linkColumns` du module
 * `envois` (services/airtableWriteback.js) — le PATCH sait désormais la traduire
 * en [recXXX] — et ce sens n'a plus qu'à être posé : un champ dynamique part en
 * 'pull' par défaut.
 *
 * Une différence avec la commande : l'adresse est nullable. La vider dans l'ERP
 * pousse [] et délie le record côté Airtable, ce qui recalcule le lookup
 * « Pays de l'adresse de livraison ».
 *
 * Idempotent : ne touche rien si l'utilisateur a déjà choisi un sens.
 */
export const id = '016-envois-address-link-two-way'
export const description = 'envois : « Adresse de livraison » (address_id) en sens bidirectionnel'

export function up(db) {
  const mapped = db.prepare(`
    SELECT id FROM airtable_field_mappings
     WHERE erp_table='shipments' AND column_name='address_id' AND import_disabled IS NOT 1
  `).get()
  if (!mapped) return { skipped: 'address_id sans mapping Airtable actif' }

  const existing = db.prepare(
    "SELECT direction FROM airtable_field_directions WHERE module='envois' AND field_key='dyn:address_id'"
  ).get()
  if (existing) return { skipped: `sens déjà réglé (${existing.direction})` }

  db.prepare(`
    INSERT INTO airtable_field_directions (module, field_key, direction)
    VALUES ('envois', 'dyn:address_id', 'both')
  `).run()
  return { direction: 'both' }
}
