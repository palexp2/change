/**
 * 034 — « Adresse de livraison » d'une commande : bidirectionnelle et mono.
 *
 * Même remède que 015/016 pour les envois, appliqué aux commandes. La colonne
 * miroir `orders.adresse_de_livraison` (champ lien Airtable, record ids bruts)
 * était en sens IMPORT : la fiche ne pouvait que l'afficher, le picker restait
 * fermé — toute saisie aurait été écrasée au prochain sync. Elle rejoint
 * `linkColumns` du module `orders` (services/airtableWriteback.js), qui sait
 * désormais pousser un tableau de record ids ; il ne reste qu'à poser le sens,
 * un champ dynamique partant en 'pull' par défaut.
 *
 * `link_single` : une commande n'a QU'UNE adresse de livraison (c'est aussi ce
 * que porte `orders.address_id`, que les envois lisent). Le drapeau dit au
 * client de proposer un picker mono — choisir remplace, pas de « + ».
 *
 * Idempotent : ne touche pas au sens si l'utilisateur en a déjà choisi un.
 */
import db from '../database.js'

export const id = '034-orders-adresse-livraison-two-way'
export const description =
  'orders : « Adresse de livraison » (adresse_de_livraison) en sens bidirectionnel, lien unique'

export function up(migrationDb) {
  const d = migrationDb || db
  const out = {}

  const mapped = d.prepare(`
    SELECT id FROM airtable_field_mappings
     WHERE erp_table='orders' AND column_name='adresse_de_livraison' AND import_disabled IS NOT 1
  `).get()
  if (!mapped) return { skipped: 'adresse_de_livraison sans mapping Airtable actif' }

  const existing = d.prepare(
    "SELECT direction FROM airtable_field_directions WHERE module='orders' AND field_key='dyn:adresse_de_livraison'"
  ).get()
  if (existing) {
    out.direction = `déjà réglé (${existing.direction})`
  } else {
    d.prepare(`
      INSERT INTO airtable_field_directions (module, field_key, direction)
      VALUES ('orders', 'dyn:adresse_de_livraison', 'both')
    `).run()
    out.direction = 'both'
  }

  out.link_single = d.prepare(`
    UPDATE custom_fields SET link_single=1
     WHERE erp_table='orders' AND column_name='adresse_de_livraison' AND deleted_at IS NULL
  `).run().changes

  return out
}
