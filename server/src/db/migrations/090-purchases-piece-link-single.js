/**
 * 090 — « Nom de la pièce » d'un achat : un seul lien.
 *
 * Un achat porte UNE pièce (c'est ce que lisent productPurchase et
 * purchaseLiaMatch, qui ne prennent que le premier lien). Le champ lien Airtable
 * laissait pourtant le picker de la fiche ajouter des pièces à la suite. Le
 * drapeau `link_single` (cf. 034) fait du picker un choix qui remplace, sans
 * « + ». Demande de Pierre-Alexandre Papillon (2026-09-24).
 */
export const id = '090-purchases-piece-link-single'
export const description = 'purchases : « Nom de la pièce » (nom_de_la_piece) limité à un seul lien'

export function up(db) {
  const changes = db.prepare(`
    UPDATE custom_fields SET link_single=1
     WHERE erp_table='purchases' AND column_name='nom_de_la_piece' AND deleted_at IS NULL
  `).run().changes
  return { link_single: changes }
}
