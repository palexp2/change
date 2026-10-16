/**
 * 143 — Pièces : « Quantité en inventaire » (stock_qty) est tenue par Boréal.
 *
 * Demande de Charles (2026-10-16) : le stock affiché venait d'Airtable et
 * divergeait du calcul Boréal (services/partStock.js) — envois faits dans
 * Boréal sans « Dans la boîte » cochée. Boréal l'écrit désormais
 * (services/dynamicThresholdWatcher.js) ; l'import Airtable est gelé.
 */
export const id = '143-products-stock-qty-boreal-owned'
export const description = 'Pièces : gèle à l’import la quantité en inventaire (calculée par Boréal)'

export function up(db) {
  db.prepare(`INSERT OR IGNORE INTO airtable_frozen_columns (erp_table, column_name, frozen_by) VALUES ('products', 'stock_qty', NULL)`).run()
}
