/**
 * 142 — Pièces : les colonnes du seuil dynamique sont tenues par Boréal.
 *
 * Demande de Charles (2026-10-15) : la vue « À acheter » ne montrait que 4
 * pièces sur 15 — elle lisait les formules Airtable recopiées, périmées. Boréal
 * les calcule désormais (services/dynamicThreshold.js, écrites par
 * services/dynamicThresholdWatcher.js, automation `sys_dynamic_threshold`).
 *
 * Gel à l'import (airtable_frozen_columns) plutôt que import_disabled : un
 * mapping désactivé cache la colonne de toute l'interface, un gel la garde
 * visible, triable et filtrable. « Seuil min. produits finis » n'est PAS gelé :
 * il reste saisi dans Airtable pour les produits finis ; seul celui des kanbans
 * est réécrit par Boréal après chaque synchro.
 */
export const id = '142-products-dynamic-threshold-boreal-owned'
export const description = 'Pièces : gèle à l’import les colonnes du seuil dynamique (calculées par Boréal)'

const COLUMNS = [
  'quantite_a_commander', 'seuil_dynamique', 'restant_avant_seuil_dynamique',
  'pourcentage_restant_seuil_dynamique', 'quantite_sera_disponible',
  'seuil_minimum_produits_x_quantite_necessaire',
  'quantite_dans_les_produits_produits_x_quantite_necessaire', 'quantite_a_recevoir',
]

export function up(db) {
  const live = new Set(db.prepare('PRAGMA table_info(products)').all().map(c => c.name))
  const ins = db.prepare(`INSERT OR IGNORE INTO airtable_frozen_columns (erp_table, column_name, frozen_by) VALUES ('products', ?, NULL)`)
  for (const c of COLUMNS) if (live.has(c)) ins.run(c)
}
