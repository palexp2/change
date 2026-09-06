/**
 * 017 — trace du gel du « coût total au moment de l'envoi ».
 *
 * `order_items.cout_total_au_moment_de_l_envoi` porte deux populations qu'on ne
 * savait pas distinguer : les valeurs héritées de la formule Airtable (3 665
 * lignes à la reprise, cf. migration 012) et celles gelées par l'ERP au moment
 * de l'envoi. La colonne ajoutée ici date le gel fait par l'ERP — c'est ce qui
 * permet de dire, sur une fiche commande, qu'un coût vient du calcul actuel
 * (Pièces + valeur de fabrication de chaque numéro de série) plutôt que de
 * l'historique, et de reconnaître les lignes recalculées à la demande.
 *
 * Purement additif : aucune valeur existante n'est touchée.
 */
export const id = '017-shipped-cost-frozen-at'
export const description = "order_items : date du gel du coût au moment de l'envoi"

export function up(db) {
  const cols = db.prepare('PRAGMA table_info(order_items)').all().map(c => c.name)
  if (cols.includes('shipped_cost_frozen_at')) return { skipped: 'colonne déjà présente' }
  db.exec('ALTER TABLE order_items ADD COLUMN shipped_cost_frozen_at TEXT')
  return { added: 'shipped_cost_frozen_at' }
}
