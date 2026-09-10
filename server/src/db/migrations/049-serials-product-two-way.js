/**
 * 049 — « Produit » d'un numéro de série : bidirectionnel.
 *
 * Même remède que 015/016 (envois) et 034 (adresse de livraison d'une
 * commande). La colonne `serial_numbers.product_id` est mappée sur le champ
 * lien « Produit » d'Airtable, mais elle était verrouillée en sens IMPORT :
 * /champs/serial_numbers affichait « Les champs lien ne sont pas réécrits vers
 * Airtable », sans recours. Or le produit se choisit DANS la fiche
 * (PATCH /api/serials/:id) — l'association posée là était donc écrasée au sync
 * suivant par ce que disait Airtable.
 *
 * `product_id` rejoint `linkColumns` du module `serials`
 * (services/airtableWriteback.js), qui sait pousser un tableau de record ids ;
 * il ne reste qu'à poser le sens, un champ dynamique partant en 'pull'.
 *
 * Idempotent : ne touche pas au sens si l'utilisateur en a déjà choisi un.
 */
import db from '../database.js'

export const id = '049-serials-product-two-way'
export const description =
  'serials : « Produit » (product_id) en sens bidirectionnel'

export function up(migrationDb) {
  const d = migrationDb || db

  const mapped = d.prepare(`
    SELECT id FROM airtable_field_mappings
     WHERE erp_table='serial_numbers' AND column_name='product_id' AND import_disabled IS NOT 1
  `).get()
  if (!mapped) return { skipped: 'product_id sans mapping Airtable actif' }

  const existing = d.prepare(
    "SELECT direction FROM airtable_field_directions WHERE module='serials' AND field_key='dyn:product_id'"
  ).get()
  if (existing) return { direction: `déjà réglé (${existing.direction})` }

  d.prepare(`
    INSERT INTO airtable_field_directions (module, field_key, direction)
    VALUES ('serials', 'dyn:product_id', 'both')
  `).run()
  return { direction: 'both' }
}
