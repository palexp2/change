/**
 * 050 — « Entreprise de la dernière commande (lien) » (numéros de série) :
 * suppression DÉFINITIVE.
 *
 * Demande depuis /champs/serial_numbers : « supprime définitivement le champ
 * Entreprise de la dernière commande (lien) ».
 *
 * CE QUE CE CHAMP DÉSIGNE. Le 2026-09-08 à 17:06, le champ lien Airtable
 * « Entreprise de la dernière commande (lien) » (fldoeuiBGZRM9lVGD) a été mappé
 * sur la colonne `serial_numbers.company_name` : la ligne `custom_fields` de
 * cette colonne — jusque-là le LOOKUP « Entreprise » (company_id → companies.name)
 * qui sert d'affichage à la liste des numéros de série — a été convertie en
 * champ `data`, ce qui a matérialisé une VRAIE colonne SQL `company_name`, et le
 * champ a pris le nom du champ Airtable. Résultat : une colonne à 0 valeur sur
 * 5 442 numéros de série, en sens « Bidirectionnel » vers un champ LIEN
 * d'Airtable — c'est-à-dire prête à y pousser du vide.
 *
 * PÉRIMÈTRE, ET CE QUI RESTE VOLONTAIREMENT. Seul ce champ-là est détruit :
 * - `serial_numbers.company_id` (4 301 valeurs) N'EST PAS TOUCHÉE. C'est la
 *   donnée : elle porte l'onglet « Numéros de série » d'une fiche entreprise
 *   (routes/companies.js), l'agrégat des permissions de contrôleur central
 *   (utils/ccPermissions.js, utils/centralController.js) et le dernier recours
 *   de l'entreprise d'un retour (services/returnCompany.js).
 * - la colonne « Entreprise » de la liste des numéros de série reste : elle
 *   s'affiche depuis le lookup, que `seedNativeFieldConversions()` réinstalle au
 *   démarrage suivant — d'où le simple DELETE de la ligne `custom_fields` ici
 *   (les seeds tournent APRÈS les migrations, puis `regenerateAllViews()`).
 *
 * Registre du miroir : la ligne `airtable_field_map` du champ passe en
 * `state='excluded'` + `decided_by='user'`, seule marque que le rafraîchissement
 * du registre respecte. Sans elle le champ retomberait dans les « sans
 * décision » du miroir dès que sa ligne de mapping disparaît.
 *
 * La ligne `airtable_field_mappings` est SUPPRIMÉE plutôt que passée en
 * `import_disabled=1` (recette 033) : la pierre tombale figerait un `erp_column`
 * pointant sur une colonne détruite, et la décision « ne pas importer ce champ »
 * est déjà portée par le registre ci-dessus.
 *
 * Garde-fou conservé (recette 023/029) : la colonne doit être VIDE. Détruire des
 * valeurs ne fait pas partie de la demande — il n'y en a pas. Chaque garde-fou
 * renvoie `skipped` au lieu de lever : une exception arrêterait le démarrage.
 */
import db from '../database.js'
import { regenerateView } from '../../services/customFieldsView.js'

export const id = '050-drop-serials-company-name-link'
export const description =
  'serial_numbers.company_name droppée — champ « Entreprise de la dernière commande (lien) » détruit'

const TABLE = 'serial_numbers'
const COLUMN = 'company_name'
const MIRROR = 'serials'
const AT_FIELD = 'Entreprise de la dernière commande (lien)'

export function up(migrationDb) {
  const d = migrationDb || db

  const cols = new Set(d.pragma(`table_info(${TABLE})`).map(c => c.name))
  if (!cols.has(COLUMN)) return { skipped: 'colonne déjà absente' }

  // Le champ a été re-rempli entre-temps : on ne détruit pas de valeurs dans le
  // dos de l'utilisateur.
  const filled = d.prepare(
    `SELECT COUNT(*) AS n FROM ${TABLE} WHERE [${COLUMN}] IS NOT NULL AND [${COLUMN}] != ''`
  ).get().n
  if (filled) return { skipped: `${filled} valeur(s) — colonne non vide` }

  // Un lookup / rollup d'une autre table qui viserait la colonne serait vidé en
  // silence.
  const dependent = d.prepare(
    `SELECT erp_table, name FROM custom_fields
      WHERE deleted_at IS NULL
        AND ((lookup_target_table=? AND lookup_target_column=?)
          OR (rollup_target_table=? AND rollup_target_column=?))`
  ).get(TABLE, COLUMN, TABLE, COLUMN)
  if (dependent) return { skipped: `champ calculé dépendant : ${dependent.erp_table}.${dependent.name}` }

  d.exec(`DROP VIEW IF EXISTS ${TABLE}_v`)
  d.exec(`ALTER TABLE ${TABLE} DROP COLUMN [${COLUMN}]`)

  // La ligne du champ part avec la colonne. `seedNativeFieldConversions()` la
  // réinstalle juste après, dans sa forme d'origine : lookup « Entreprise » sur
  // company_id — l'affichage de la liste, pas un champ importable.
  d.prepare(`DELETE FROM custom_fields WHERE erp_table=? AND column_name=?`).run(TABLE, COLUMN)
  try {
    d.prepare(`DELETE FROM airtable_field_defs WHERE erp_table=? AND column_name=?`).run(TABLE, COLUMN)
  } catch { /* table héritée absente */ }

  const mapping = d.prepare(
    `DELETE FROM airtable_field_mappings WHERE erp_table=? AND column_name=?`
  ).run(TABLE, COLUMN).changes

  const directions = d.prepare(
    `DELETE FROM airtable_field_directions WHERE module=? AND field_key IN (?,?)`
  ).run(MIRROR, `dyn:${COLUMN}`, COLUMN).changes

  const excluded = d.prepare(`
    UPDATE airtable_field_map
       SET state='excluded', direction='none', erp_column=NULL, core_key=NULL,
           exclude_reason=?, decided_by='user',
           decided_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE mirror_id=? AND (field_name=? OR erp_column=?)
  `).run('champ ERP supprimé — colonne droppée (migration 050)', MIRROR, AT_FIELD, COLUMN).changes

  regenerateView(TABLE)

  return {
    dropped: `${TABLE}.${COLUMN}`,
    mapping_removed: mapping, directions_removed: directions,
    mirror_rows_excluded: excluded,
  }
}
