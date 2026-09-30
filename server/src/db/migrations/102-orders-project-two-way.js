/**
 * 102 — « Projet » d'une commande : bidirectionnel.
 *
 * Même remède que 034 pour l'adresse de livraison. `orders.project_id` était
 * en sens IMPORT : un projet lié depuis la fiche disparaissait au sync suivant,
 * Airtable ne l'ayant jamais reçu. La colonne rejoint `linkColumns` du module
 * `orders` (services/airtableWriteback.js) ; il reste à poser le sens.
 *
 * Idempotent : ne touche pas au sens si l'utilisateur en a déjà choisi un.
 */

export const id = '102-orders-project-two-way'
export const description = 'orders : « Projet » (project_id) en sens bidirectionnel'

export function up(db) {
  const mapped = db.prepare(`
    SELECT id FROM airtable_field_mappings
     WHERE erp_table='orders' AND column_name='project_id' AND import_disabled IS NOT 1
  `).get()
  if (!mapped) return { skipped: 'project_id sans mapping Airtable actif' }

  const existing = db.prepare(
    "SELECT direction FROM airtable_field_directions WHERE module='orders' AND field_key='dyn:project_id'"
  ).get()
  if (existing) return { direction: `déjà réglé (${existing.direction})` }

  db.prepare(`
    INSERT INTO airtable_field_directions (module, field_key, direction)
    VALUES ('orders', 'dyn:project_id', 'both')
  `).run()
  return { direction: 'both' }
}
