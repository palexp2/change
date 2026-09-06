import db from '../db/database.js'
import { writebackModuleForTable, dynamicFieldDirection } from './airtableWriteback.js'

// ── Règle d'éditabilité unique des champs personnalisés ──────────────────────
//
// Une valeur est éditable dans l'ERP ⟺ l'ERP est ce qui l'écrit :
//   • colonne sans mapping Airtable actif (aucun import ne l'alimente), OU
//   • mapping dont l'import est coupé (import_disabled=1), OU
//   • mapping dont le sens de sync est 'push' ou 'both' (write-back).
//
// Ce qui compte est le MAPPING, pas `custom_fields.source` : un champ créé à la
// main puis mappé sur un champ Airtable est alimenté par le sync exactement comme
// un champ adopté, et sa saisie serait écrasée pareil. `source`, lui, dit d'où
// vient la DÉFINITION du champ (et sert aux fiches, qui n'affichent que les
// champs créés ici) — il ne dit rien de qui écrit la valeur.
//
// Un champ Airtable en 'pull' avec import actif est en LECTURE SEULE : toute
// écriture ERP serait écrasée au prochain sync — perte silencieuse. Cette règle
// est LA source de vérité, partagée entre les routes PATCH (whitelist d'update)
// et le GET des champs custom (flag `writable` consommé par le client).
//
// Le sens des champs dynamiques est stocké dans airtable_field_directions sous
// la clé `dyn:<colonne>` PAR MODULE write-back (writebackModuleForTable) —
// défaut 'pull'. Un module hors write-back n'a aucun sens configurable : tous
// ses champs Airtable importés sont en lecture seule.

export const AIRTABLE_PULL_EDIT_ERROR =
  "Champ importé d'Airtable (sens import) — passez-le en bidirectionnel ou coupez l'import pour l'éditer"

// Vrai si la colonne (ligne custom_fields enrichie de son mapping Airtable)
// est éditable dans l'ERP selon la règle ci-dessus.
//   row : { column_name, source, mapping_id, import_disabled }
export function isColumnWritable(erpTable, row, module = writebackModuleForTable(erpTable)) {
  const hasActiveMapping = row.mapping_id != null && row.import_disabled !== 1
  if (hasActiveMapping) {
    const direction = dynamicFieldDirection(module, row.column_name)
    return direction === 'push' || direction === 'both'
  }
  return true
}

// Lignes custom_fields kind='data' de la table, jointes à leur mapping Airtable
// (le mapping '__pending__' n'a pas encore de colonne → jamais joint).
function activeDataColumnsWithMapping(erpTable) {
  return db.prepare(`
    SELECT cf.column_name, cf.type, cf.decimals, cf.source,
           m.id AS mapping_id, m.import_disabled
    FROM custom_fields cf
    LEFT JOIN airtable_field_mappings m
      ON m.erp_table = cf.erp_table AND m.column_name = cf.column_name
    WHERE cf.erp_table = ? AND cf.deleted_at IS NULL AND cf.kind = 'data'
  `).all(erpTable)
}

// Colonnes custom ÉDITABLES d'une table — même forme que getActiveCustomColumns
// (routes/custom-fields.js) mais filtrée par la règle d'éditabilité. À utiliser
// comme whitelist des PATCH des routes d'entité (projects, payments…).
export function getWritableCustomColumns(erpTable) {
  const module = writebackModuleForTable(erpTable)
  return activeDataColumnsWithMapping(erpTable)
    .filter(row => isColumnWritable(erpTable, row, module))
    .map(({ column_name, type, decimals }) => ({ column_name, type, decimals }))
}

// Clés du body refusées parce qu'elles visent un champ Airtable en import seul.
// `buildPartialUpdate` ignore silencieusement les clés hors whitelist — pour ces
// colonnes-là on veut un 400 explicite (AIRTABLE_PULL_EDIT_ERROR), pas une
// écriture qui semble réussir puis disparaît au sync suivant.
export function refusedAirtablePullKeys(erpTable, body) {
  if (!body || typeof body !== 'object') return []
  const module = writebackModuleForTable(erpTable)
  return activeDataColumnsWithMapping(erpTable)
    .filter(row => !isColumnWritable(erpTable, row, module))
    .map(row => row.column_name)
    .filter(col => Object.prototype.hasOwnProperty.call(body, col))
}
