/**
 * 109 — Plus aucune référence aux champs détruits définitivement.
 *
 * Demande de Guillaume (2026-10-02) : la formule « Statut » des Retours citait
 * `nombre_d_items_a_analyser`, champ purgé le 2026-09-24 (« Vider la
 * corbeille ») — absent de /champs/retours, mais toujours lu, avec des valeurs
 * figées depuis l'arrêt de son import (475 retours sur 484 « à analyser »).
 * « Supprimer toutes les références aux champs qui ont été supprimés
 * définitivement. »
 *
 * Ce qui est nettoyé ici, une fois pour toutes (la purge le fait elle-même
 * désormais, cf. cleanPurgedReferences dans services/fieldPurge.js) :
 *   - vues enregistrées, vue « Tous », disposition des fiches, formulaires
 *     d'ajout, colonnes gelées du sync, pour chacune des 718 pierres tombales ;
 *   - « Statut » des Retours : retour à la formule de 069, sans la branche
 *     « À analyser » (Boréal n'a pas la condition d'Airtable, voir 069) ;
 *   - « Boréal recordId » des billets (formule = `record_id`, rien d'autre) et
 *     « Date du premier envoi de la commande liée » des factures (lookup sur
 *     `orders.date_du_premier_envoi`) : envoyés à la corbeille.
 *   - la règle système « Escalade Hardware → Slack » (déjà désactivée, sur le
 *     champ Escalade détruit) est retirée par systemAutomations.js.
 *
 * Ce qui reste VOLONTAIREMENT :
 *   - les lookups/rollups sur `shipments.created_at` : cette colonne porte le
 *     champ vivant « Date » (created_time) des envois ; seule sa ligne technique
 *     brute a été purgée ;
 *   - le code serveur qui lit encore des colonnes natives purgées (la colonne
 *     SQL reste, cf. fieldPurge.js) et les décisions « ne pas importer » du
 *     miroir Airtable (import_disabled / state='excluded').
 */
import { cleanPurgedReferences } from '../../services/fieldPurge.js'
import { regenerateView } from '../../services/customFieldsView.js'

export const id = '109-clean-purged-field-references'
export const description = 'Retire des vues, fiches, formulaires et formules les champs détruits définitivement'

const STATUT_FORMULA =
  'IF(cf_nb_items = 0, "Aucun item à retourner", ' +
  'IF(cf_items_a_recevoir > 0, "En transit", "Analyse complétée"))'

// Champs dont toute la définition repose sur un champ détruit.
const TRASH_FIELDS = [
  { table: 'tickets', column: 'cf_boreal_recordid', dep: 'record_id' },
  { table: 'factures', column: 'cf_date_du_premier_envoi_de_la_commande_lie', dep: 'date_du_premier_envoi' },
]

export function up(d) {
  const report = { tables: {}, statut: 'inchangé', trashed: [] }

  // Une colonne purgée puis ré-adoptée par un champ vivant n'est plus morte.
  const purged = d.prepare(`
    SELECT p.erp_table, p.column_name FROM purged_fields p
    WHERE NOT EXISTS (
      SELECT 1 FROM custom_fields cf
      WHERE cf.erp_table = p.erp_table AND cf.column_name = p.column_name AND cf.deleted_at IS NULL)
  `).all()
  const byTable = new Map()
  for (const p of purged) {
    // `retours` : une pierre tombale posée sous la clé de vue, pas la table SQL.
    const t = p.erp_table === 'retours' ? 'returns' : p.erp_table
    if (!byTable.has(t)) byTable.set(t, new Set())
    byTable.get(t).add(p.column_name)
  }
  for (const [table, cols] of byTable) {
    const r = cleanPurgedReferences(table, cols)
    if (Object.values(r).some(Boolean)) report.tables[table] = r
  }

  const statut = d.prepare(`
    SELECT id, formula_expr FROM custom_fields
    WHERE erp_table='returns' AND column_name='cf_statut' AND kind='formula' AND deleted_at IS NULL
  `).get()
  if (statut && /\bnombre_d_items_a_analyser\b/.test(statut.formula_expr || '')) {
    d.prepare(`UPDATE custom_fields SET formula_expr=?, view_error=NULL,
                 updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
      .run(STATUT_FORMULA, statut.id)
    regenerateView('returns')
    report.statut = 'branche « À analyser » retirée'
  }

  for (const f of TRASH_FIELDS) {
    const row = d.prepare(`
      SELECT id, formula_expr, lookup_target_column FROM custom_fields
      WHERE erp_table=? AND column_name=? AND deleted_at IS NULL
    `).get(f.table, f.column)
    if (!row) continue
    // Garde-fou : seulement si le champ dépend toujours du champ détruit.
    if (row.formula_expr?.trim() !== f.dep && row.lookup_target_column !== f.dep) continue
    d.prepare(`UPDATE custom_fields SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                 updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(row.id)
    regenerateView(f.table)
    report.trashed.push(`${f.table}.${f.column}`)
  }

  return report
}
