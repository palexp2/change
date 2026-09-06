/**
 * 011 — pierres tombales permanentes des champs purgés.
 *
 * Un champ dans la corbeille est une ligne `custom_fields` soft-supprimée. Pour
 * un champ NATIF (ou adopté), cette ligne EST ce qui le tient hors de
 * l'interface : sa définition vit dans `tableDefs.js` côté client, et
 * `GET /api/custom-fields/:table/native` republie les lignes supprimées avec
 * `hidden: true` pour que le portier des champs les retire de partout. D'où
 * l'effet absurde du bouton « Vider la corbeille » : détruire la ligne faisait
 * REVENIR le champ sur toutes les fiches.
 *
 * Cette table est la mémoire qui survit à la purge. Une entrée ici = « ce champ
 * a été détruit définitivement, il ne réapparaît jamais ». Elle ne porte aucune
 * donnée métier, juste le libellé au moment de la purge (pour les logs et pour
 * qu'un futur écran puisse dire de quoi il s'agissait).
 *
 * Une re-création explicite du champ (adoption d'une colonne, personnalisation
 * d'un natif) l'emporte : la lecture ignore une pierre tombale dont la colonne
 * a de nouveau un champ vivant, et la route « remettre » l'efface.
 */
export const id = '011-purged-fields'
export const description = 'purged_fields : pierres tombales permanentes des champs vidés de la corbeille'

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS purged_fields (
      erp_table   TEXT NOT NULL,
      column_name TEXT NOT NULL,
      label       TEXT,
      dropped     INTEGER NOT NULL DEFAULT 0,
      purged_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (erp_table, column_name)
    )
  `)
  return { created: 'purged_fields' }
}
