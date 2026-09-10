/**
 * 051 — Paies : suppression des champs « csv » et « Période de paie » sur
 * /champs/paies.
 *
 * Demande depuis /champs/paies. Les deux lignes visées ne sont PAS des colonnes
 * de la table Paies (aucune n'a jamais été adoptée en champ perso — cf.
 * `nativeFieldConversions.js`) : elles n'apparaissaient que parce que
 * `retirePaiesCoreFieldMap` (2026-09-06) avait posé une ligne
 * `airtable_field_mappings` pour chacune, rendant leur champ Airtable
 * réglable depuis la page. `mergedBase` de FieldConfig.jsx les affiche tant
 * qu'elles sont `mapped` — les démapper les fait disparaître pour de bon.
 *
 * ── Deux traitements différents ───────────────────────────────────────────
 *  • `csv` — colonne texte jamais lue par l'ERP (aucun consommateur en dehors
 *    du sync qui l'écrit et de `changeLog.js` qui l'exclut du journal) :
 *    DROP COLUMN complet, comme 023/028/029/030/033/045/046/048.
 *  • `period_start` — LE CONTRAIRE d'une colonne morte : 83/83 paies
 *    renseignées, lue par `routes/dashboard.js` (projection de la masse
 *    salariale), `services/paieSalaryExpense.js` (calcul de la dépense),
 *    `services/paieTimesheetImport.js` (période des feuilles de temps),
 *    `routes/paies.js` (appariement bancaire) et affichée dans
 *    `pages/Paies.jsx` / `ComptaDashboard.jsx` / `tableDefs.js`. La détruire
 *    casserait la projection de trésorerie de la paie. Seul son MAPPING
 *    Airtable (« Période de paie ») est retiré : la colonne, elle, reste
 *    intacte et continue d'être alimentée en interne (règle des 14 jours,
 *    cf. `paieTimesheetImport.computePeriod`).
 *
 * Ce qu'il a fallu couper côté code (hors migration, cf. commit) :
 *  • `services/airtableUiFieldMap.js` — retrait de `csv` et `period_range` de
 *    `PAIES_FIELD_MAP_PLAN` (sinon un futur redémarrage ne recrée rien, mais
 *    la clé resterait remappable depuis le picker « Champ Airtable ») ;
 *  • `services/airtableMirrorEngine.js` — `CORE_PLANS.paies.fields` perd
 *    `csv` (colonne détruite) ; `paiesDerive` perd le calcul de
 *    `period_start` (mort : `fieldMap.period_range` n'existe plus) ;
 *  • `services/airtable.js` (`syncPaies`, chemin de secours + bouton de sync
 *    manuel qui l'appelle directement) — mêmes retraits, sinon le prochain
 *    sync échoue sur `csv` (colonne disparue) et réécrit `period_start` avec
 *    une valeur toujours nulle (inoffensif grâce au COALESCE existant, mais
 *    mort).
 *
 * Même voie que 023/028/029/030/033/045/046/048 (migration numérotée, tracée
 * dans `schema_migrations`, appliquée au `pm2 restart`). Garde-fous en
 * `skipped` plutôt qu'une exception — qui arrêterait le démarrage.
 */
import fs from 'node:fs'
import path from 'node:path'
import db from '../database.js'
import { regenerateView } from '../../services/customFieldsView.js'

export const id = '051-paies-drop-csv-unmap-period-start'
export const description =
  'paies.csv droppée, paies.period_start démappée d’Airtable (colonne conservée — usage interne)'

const TABLE = 'paies'
const DROP_COLUMN = 'csv'
const UNMAP_COLUMN = 'period_start'
const MIRROR = 'paies'

export function up(migrationDb) {
  const d = migrationDb || db
  const result = {}

  // ── csv : DROP COLUMN ──────────────────────────────────────────────────
  const cols = new Set(d.pragma(`table_info(${TABLE})`).map(c => c.name))
  if (cols.has(DROP_COLUMN)) {
    const dependent = d.prepare(
      `SELECT erp_table, name FROM custom_fields
        WHERE deleted_at IS NULL
          AND ((lookup_target_table=? AND lookup_target_column=?)
            OR (rollup_target_table=? AND rollup_target_column=?))`
    ).get(TABLE, DROP_COLUMN, TABLE, DROP_COLUMN)
    if (dependent) {
      result.csv = { skipped: `champ calculé dépendant : ${dependent.erp_table}.${dependent.name}` }
    } else {
      const formula = d.prepare(
        `SELECT erp_table, name FROM custom_fields
          WHERE deleted_at IS NULL AND kind='formula' AND formula_expr LIKE ?`
      ).get(`%${DROP_COLUMN}%`)
      if (formula) {
        result.csv = { skipped: `formule dépendante : ${formula.erp_table}.${formula.name}` }
      } else {
        const backup = backupValues(d)
        d.exec(`DROP VIEW IF EXISTS ${TABLE}_v`)
        d.exec(`ALTER TABLE ${TABLE} DROP COLUMN [${DROP_COLUMN}]`)
        const mappings = d.prepare('DELETE FROM airtable_field_mappings WHERE erp_table=? AND column_name=?')
          .run(TABLE, DROP_COLUMN).changes
        const fields = d.prepare('DELETE FROM custom_fields WHERE erp_table=? AND column_name=?')
          .run(TABLE, DROP_COLUMN).changes
        excludeFromMirrorRegistry(d, 'csv', DROP_COLUMN)
        result.csv = { dropped: `${TABLE}.${DROP_COLUMN}`, backup, airtable_mappings_removed: mappings, custom_fields_removed: fields }
      }
    }
  } else {
    result.csv = { skipped: 'colonne déjà absente' }
  }

  // ── period_start : démapper seulement, colonne intacte ────────────────
  const unmapped = d.prepare('DELETE FROM airtable_field_mappings WHERE erp_table=? AND column_name=?')
    .run(TABLE, UNMAP_COLUMN).changes
  if (unmapped) excludeFromMirrorRegistry(d, 'period_range', null)
  result.period_start = { airtable_mappings_removed: unmapped }

  regenerateView(TABLE)

  return result
}

// Sauvegarde des valeurs qu'on s'apprête à détruire (cf. fieldPurge.js).
function backupValues(d) {
  try {
    const dir = path.join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'backups')
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)
    const file = path.join(dir, `champs-purges-${TABLE}-${DROP_COLUMN}-${stamp}.json`)
    const rows = d.prepare(
      `SELECT id, [${DROP_COLUMN}] FROM ${TABLE} WHERE [${DROP_COLUMN}] IS NOT NULL AND [${DROP_COLUMN}] != ''`
    ).all()
    fs.writeFileSync(file, JSON.stringify(
      { table: TABLE, columns: [DROP_COLUMN], purged_at: new Date().toISOString(), rows }, null, 1))
    return file
  } catch (e) {
    console.warn(`[051] sauvegarde ${TABLE}.${DROP_COLUMN} impossible :`, e.message)
    return null
  }
}

// Registre du miroir : le champ Airtable existe toujours côté Airtable, il
// n'est simplement plus importé. `decided_by='user'` est la seule marque que
// le rafraîchissement du registre respecte (cf. 046) — sans elle, le champ
// retomberait dans les « sans décision ».
function excludeFromMirrorRegistry(d, coreKey, erpColumn) {
  return d.prepare(`
    UPDATE airtable_field_map
    SET state='excluded', direction='none', erp_column=NULL, core_key=NULL,
        exclude_reason=?, decided_by='user',
        decided_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE mirror_id=? AND (core_key=? OR erp_column=?)
  `).run('champ retiré de /champs/paies (migration 051)', MIRROR, coreKey, erpColumn || coreKey).changes
}
