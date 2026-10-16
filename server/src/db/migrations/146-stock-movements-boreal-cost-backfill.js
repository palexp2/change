/**
 * 146 — Mouvements d'inventaire saisis dans Boréal : coût et valeur manquants.
 *
 * Signalé par Charles (2026-10-16) : un ajustement fait depuis la fiche pièce
 * n'avait aucune valeur. La route l'enregistre désormais ; ici on complète ceux
 * déjà saisis avec le coût unitaire actuel de la pièce.
 */
export const id = '146-stock-movements-boreal-cost-backfill'
export const description = 'Mouvements Boréal : coût unitaire et valeur complétés'

export function up(d) {
  const r = d.prepare(`
    UPDATE stock_movements
       SET unit_cost = (SELECT p.unit_cost FROM products p WHERE p.id = stock_movements.product_id),
           movement_value = ROUND(ABS(qty) * (SELECT p.unit_cost FROM products p WHERE p.id = stock_movements.product_id), 2)
     WHERE user_id IS NOT NULL AND unit_cost IS NULL
       AND (SELECT p.unit_cost FROM products p WHERE p.id = stock_movements.product_id) IS NOT NULL`).run()
  return { updated: r.changes }
}
