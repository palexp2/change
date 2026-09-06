/**
 * 006 — Override manuel des coûts d'une commande.
 *
 * Pendant du `revenue_override_cad` existant. Le coût calculé (COGS) est la
 * somme des lignes 'Facturable' au coût d'expédition ; il est parfois faux ou
 * incomplet (pièces non saisies, sous-traitance, transport). L'utilisateur doit
 * pouvoir poser la valeur réelle sans réécrire les lignes de la commande.
 *
 * NULL = utiliser le coût calculé depuis les articles (comportement actuel).
 * Cette migration n'altère donc aucun chiffre existant.
 */

export const id = '006-order-cogs-override'
export const description = 'Ajoute orders.cogs_override_cad (override manuel des coûts)'

export function up(db) {
  const cols = db.prepare('PRAGMA table_info(orders)').all().map(c => c.name)
  if (cols.includes('cogs_override_cad')) return

  db.exec('ALTER TABLE orders ADD COLUMN cogs_override_cad REAL')
}
