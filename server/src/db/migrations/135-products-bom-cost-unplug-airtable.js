/**
 * 135 — Pièces : « Cout unitaire » n'est plus importé d'Airtable.
 *
 * Pierre-Alexandre Papillon, 2026-10-14 : « on va débrancher Airtable pour ça,
 * récupère le prix à partir de la nomenclature directement dans Boréal ».
 * La formule Airtable valait le coût de la nomenclature pour une pièce
 * fabriquée, le « Coût unitaire (FIFO) » sinon. Boréal tient désormais les
 * deux (services/bomCost.js + services/fifoCost.js, automation `sys_fifo_cost`) :
 * l'import écraserait la valeur calculée.
 *
 * Ligne de mapping gardée en import_disabled=1 (c'est elle qui marque le
 * champ Airtable « désactivé » ; la supprimer le ferait réapparaître comme
 * importable).
 */
export const id = '135-products-bom-cost-unplug-airtable'
export const description = "Pièces : coupe l'import du « Cout unitaire » Airtable (calculé par Boréal depuis la nomenclature)"

export function up(db) {
  db.prepare(`
    UPDATE airtable_field_mappings
    SET import_disabled = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE erp_table = 'products' AND column_name = 'cout_unitaire' AND import_disabled IS NOT 1
  `).run()
}
