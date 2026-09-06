/**
 * 012 — « Coût total au moment de l'envoi » passe sous la responsabilité de l'ERP.
 *
 * La colonne `order_items.cout_total_au_moment_de_l_envoi` existe depuis
 * l'import Airtable : sa valeur y est une formule (Σ des valeurs de fabrication
 * des numéros de série, sinon quantité × coût unitaire) et le sync la recopiait
 * à chaque passage. Désormais c'est l'ERP qui la calcule et la gèle quand un
 * envoi est associé à la ligne (services/shippedCost.js, déclenché par
 * services/shippedCostWatcher.js) — pour que le chiffre existe aussi quand
 * l'envoi naît dans Boréal, et qu'il soit le même dans les deux cas.
 *
 * On coupe donc l'import de ce champ. `import_disabled = 1` plutôt qu'une
 * suppression de la ligne de mapping : la ligne est ce qui EMPÊCHE le sync de
 * re-mapper le champ par son nom au prochain passage (cf. `twinDefs` /
 * `import_disabled` dans services/airtableAutoSync.js — les deux chemins, sync
 * complet et webhook, la sautent). La page /champs/order_items montre alors la
 * colonne comme non mappée, ce qui est la vérité : l'ERP en est l'auteur.
 *
 * Les valeurs déjà gelées par Airtable ne sont PAS touchées (3 665 lignes au
 * moment de la migration) : le gel est par définition définitif, et le nouveau
 * calcul ne remplit que les lignes vides.
 */
export const id = '012-shipped-cost-owned-by-erp'
export const description = "Coupe l'import Airtable de order_items.cout_total_au_moment_de_l_envoi (calculé par l'ERP au moment de l'envoi)"

export function up(db) {
  const r = db.prepare(`
    UPDATE airtable_field_mappings
    SET import_disabled = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE erp_table = 'order_items'
      AND column_name = 'cout_total_au_moment_de_l_envoi'
      AND import_disabled IS NOT 1
  `).run()
  return { mappings_disabled: r.changes }
}
