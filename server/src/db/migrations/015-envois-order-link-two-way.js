/**
 * 015 — le champ « Commande » des envois devient bidirectionnel.
 *
 * `shipments.order_id` ↔ « Commande lié » (linked record Airtable) était en
 * sens unique par construction : le write-back refusait TOUS les champs lien
 * (la colonne ERP porte un id Boréal, Airtable attend un tableau de record ids),
 * et la page /champs/shipments verrouillait le sélecteur de sens dessus. Une
 * commande corrigée dans l'ERP ne repartait donc jamais vers Airtable.
 *
 * Le module `envois` déclare désormais la colonne dans `linkColumns`
 * (services/airtableWriteback.js) : le write-back sait la traduire en
 * [recXXX] et le sens redevient réglable. Reste à POSER ce sens — un champ
 * dynamique part en 'pull' par défaut, et déclarer la colonne rend le
 * write-back possible sans l'activer.
 *
 * Idempotent : ON CONFLICT ne réécrit que si le sens est encore le défaut
 * implicite (aucune ligne) — un choix ultérieur de l'utilisateur n'est jamais
 * écrasé.
 */
export const id = '015-envois-order-link-two-way'
export const description = 'envois : « Commande » (order_id) en sens bidirectionnel'

export function up(db) {
  const mapped = db.prepare(`
    SELECT id FROM airtable_field_mappings
     WHERE erp_table='shipments' AND column_name='order_id' AND import_disabled IS NOT 1
  `).get()
  if (!mapped) return { skipped: 'order_id sans mapping Airtable actif' }

  const existing = db.prepare(
    "SELECT direction FROM airtable_field_directions WHERE module='envois' AND field_key='dyn:order_id'"
  ).get()
  if (existing) return { skipped: `sens déjà réglé (${existing.direction})` }

  db.prepare(`
    INSERT INTO airtable_field_directions (module, field_key, direction)
    VALUES ('envois', 'dyn:order_id', 'both')
  `).run()
  return { direction: 'both' }
}
