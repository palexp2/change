/**
 * 011 — réparer `projects.value_cad`, que le sync effaçait à petit feu.
 *
 * Le champ Airtable « Valeur (CAD) » a DEUX mappings : un actif vers la colonne
 * dynamique `valeur_cad`, et un DÉSACTIVÉ vers `value_cad`, la colonne
 * historique dont vivent le pipeline et le tableau de bord. Or la passe « cœur »
 * de `syncProjets` écrivait `value_cad = NULL` à chaque passage, la clé n'étant
 * pas dans son field_map — et plus personne ne la réécrivait. Chaque webhook
 * sur un projet vidait donc sa valeur, définitivement.
 *
 * Le moteur unique arrête l'hémorragie (une clé non mappée ne touche plus la
 * colonne). Restent les 14 projets déjà vidés : on leur remet la valeur que la
 * colonne jumelle a conservée. Sur les 1 484 projets où les deux existent, elles
 * sont identiques au centime près — la reprise est donc sans ambiguïté.
 */
export const id = '011-projects-value-cad-repair'
export const description = 'projects.value_cad : reprise depuis valeur_cad là où le sync l’avait effacée'

export function up(db) {
  const r = db.prepare(`
    UPDATE projects
       SET value_cad = CAST(valeur_cad AS REAL)
     WHERE airtable_id IS NOT NULL
       AND value_cad IS NULL
       AND valeur_cad IS NOT NULL
       AND CAST(valeur_cad AS REAL) > 0
  `).run()
  return { projects_repaired: r.changes }
}
