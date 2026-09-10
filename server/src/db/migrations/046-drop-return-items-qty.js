/**
 * 046 — `return_items.qty` (« Qté ») : suppression DÉFINITIVE.
 *
 * Demande depuis /champs/return_items : « supprime le champ Qté (drop column) ».
 * Même voie que 023 / 028 / 029 / 030 / 032 / 033 / 035 / 037 / 040 / 041 / 045
 * (migration numérotée, tracée dans `schema_migrations`, appliquée au
 * `pm2 restart`).
 *
 * ── Ce que la colonne était ───────────────────────────────────────────────
 * Une colonne NATIVE, jamais alimentée par Airtable : elle n'est ni dans le
 * plan des 13 clés réglables (`RETOUR_ITEMS_FIELD_MAP_PLAN`), ni dans
 * `CORE_PLANS.retour_items.fields`, ni dans `syncRetourItems` — et le champ
 * Airtable correspondant n'existe pas (aucune ligne « Qté » dans
 * `airtable_field_map` pour le miroir `retour_items`). Sa seule écriture était
 * son DEFAULT 1 : 767 lignes sur 767, une seule valeur distincte (1). Un
 * article de retour = une unité, la quantité ne qualifiait rien.
 *
 * ── Ce qu'il a fallu couper côté code (hors migration) ────────────────────
 *  • `services/recordLinks.js` — un article de retour n'a plus de sous-titre
 *    « × n » dans les liens/recherche ;
 *  • `services/ups.js` (`returnCustomsItems`) et `services/novoxpress.js`
 *    (`createReturnLabel`) — la ligne douanière compte 1 unité par article,
 *    ce que le repli `|| 1` faisait déjà ;
 *  • `db/schema.js` — la colonne sort du CREATE TABLE (initSchema tourne AVANT
 *    les migrations : une base neuve la recréerait, piège de la 026) ;
 *  • côté client `tableDefs.js` (colonne « Qté » du tableau « Articles ») et
 *    `RetourDetail.jsx` (champ « Quantité » du side-peek d'un article).
 *
 * ── Le filet ──────────────────────────────────────────────────────────────
 * Détruire les valeurs EST la demande : le garde-fou « colonne non vide » de
 * 023 ne s'applique pas (cf. 028). Il est remplacé par une sauvegarde JSON dans
 * `uploads/backups/`, comme le fait `services/fieldPurge.js`.
 *
 * Défensive : chaque garde-fou renvoie `skipped` au lieu de lever — une
 * exception arrêterait le démarrage du serveur.
 */
import fs from 'node:fs'
import path from 'node:path'
import db from '../database.js'
import { regenerateView } from '../../services/customFieldsView.js'

export const id = '046-drop-return-items-qty'
export const description =
  'return_items.qty droppée — un article de retour vaut toujours une unité'

const TABLE = 'return_items'
const COLUMN = 'qty'
const MIRROR = 'retour_items'
// Les vues sauvegardées sont rangées sous le nom de la RESSOURCE : le tableau
// « Articles » de la fiche retour (cf. TABLE_COLUMN_META / DataTable table=…).
const VIEW_TABLES = ['retour_items', 'return_items']

export function up(migrationDb) {
  const d = migrationDb || db

  const cols = new Set(d.pragma(`table_info(${TABLE})`).map(c => c.name))
  if (!cols.has(COLUMN)) return { skipped: 'colonne déjà absente' }

  // Un lookup / rollup d'une AUTRE table qui viserait la colonne serait vidé en
  // silence.
  const dependent = d.prepare(
    `SELECT erp_table, name FROM custom_fields
      WHERE deleted_at IS NULL AND erp_table <> ?
        AND ((lookup_target_table=? AND lookup_target_column=?)
          OR (rollup_target_table=? AND rollup_target_column=?))`
  ).get(TABLE, TABLE, COLUMN, TABLE, COLUMN)
  if (dependent) return { skipped: `champ calculé dépendant : ${dependent.erp_table}.${dependent.name}` }

  // Une formule DE CETTE TABLE qui nomme la colonne tomberait en erreur de vue
  // au prochain rendu.
  const formula = d.prepare(
    `SELECT name FROM custom_fields
      WHERE deleted_at IS NULL AND erp_table=? AND kind='formula' AND formula_expr LIKE ?`
  ).get(TABLE, `%${COLUMN}%`)
  if (formula) return { skipped: `formule dépendante : ${TABLE}.${formula.name}` }

  // Si l'import Airtable a été (re)branché sur la colonne par une def dynamique
  // entre temps, le sync réécrirait une colonne disparue : on s'arrête.
  const mapped = d.prepare(
    `SELECT column_name FROM airtable_field_mappings
      WHERE erp_table=? AND column_name=? AND import_disabled IS NOT 1`
  ).get(TABLE, COLUMN)
  if (mapped) return { skipped: `import Airtable actif sur ${TABLE}.${COLUMN}` }

  // SQLite refuse DROP COLUMN sur une colonne indexée.
  const indexed = d.pragma(`index_list(${TABLE})`)
    .find(ix => d.pragma(`index_info(${ix.name})`).some(c => c.name === COLUMN))
  if (indexed) return { skipped: `colonne indexée : ${indexed.name}` }

  const backup = backupValues(d)

  d.exec(`DROP VIEW IF EXISTS ${TABLE}_v`)
  d.exec(`ALTER TABLE ${TABLE} DROP COLUMN [${COLUMN}]`)

  const fields = d.prepare('DELETE FROM custom_fields WHERE erp_table=? AND column_name=?')
    .run(TABLE, COLUMN).changes
  const mappings = d.prepare('DELETE FROM airtable_field_mappings WHERE erp_table=? AND column_name=?')
    .run(TABLE, COLUMN).changes
  let defs = 0
  try {
    defs = d.prepare('DELETE FROM airtable_field_defs WHERE erp_table=? AND column_name=?')
      .run(TABLE, COLUMN).changes
  } catch { /* table héritée absente */ }

  const unmapped = removeFromLegacyFieldMap(d)
  const released = releaseMirrorRegistry(d)
  const views = cleanSavedViews(d)

  regenerateView(TABLE)

  return {
    dropped: `${TABLE}.${COLUMN}`, backup,
    custom_fields_removed: fields, airtable_mappings_removed: mappings,
    airtable_defs_removed: defs, field_map_keys_removed: unmapped,
    mirror_rows_released: released, ...views,
  }
}

// Sauvegarde des valeurs qu'on s'apprête à détruire (cf. fieldPurge.js).
function backupValues(d) {
  try {
    const dir = path.join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'backups')
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)
    const file = path.join(dir, `champs-purges-${TABLE}-${COLUMN}-${stamp}.json`)
    const rows = d.prepare(`SELECT id, [${COLUMN}] FROM ${TABLE}`).all()
    fs.writeFileSync(file, JSON.stringify(
      { table: TABLE, columns: [COLUMN], purged_at: new Date().toISOString(), rows }, null, 1))
    return file
  } catch (e) {
    console.warn(`[046] sauvegarde ${TABLE} impossible :`, e.message)
    return null
  }
}

// Le field_map « cœur » du module est à NULL depuis la bascule des articles de
// retour vers /champs/return_items, et n'a jamais porté `qty` — le nettoyage est
// purement défensif, au cas où un mapping manuel l'y aurait remis.
function removeFromLegacyFieldMap(d) {
  const row = d.prepare('SELECT field_map FROM airtable_module_config WHERE module=?').get(MIRROR)
  if (!row?.field_map) return 0
  let map
  try { map = JSON.parse(row.field_map) } catch { return 0 }
  if (!Object.hasOwn(map, COLUMN)) return 0
  delete map[COLUMN]
  // airtable_module_config n'a pas de colonne updated_at (cf. db/schema.js) :
  // l'y écrire ferait échouer la migration au démarrage.
  d.prepare('UPDATE airtable_module_config SET field_map=? WHERE module=?')
    .run(JSON.stringify(map), MIRROR)
  return 1
}

// Registre du miroir : aucune ligne ne pointe sur `qty` (le champ Airtable
// n'existe pas), mais une éventuelle ligne `core` repasserait en `unmapped`.
// `undecided` n'existe pas : le CHECK de la table (migration 004) n'accepte que
// mirrored / core / excluded / unmapped / broken.
function releaseMirrorRegistry(d) {
  return d.prepare(`
    UPDATE airtable_field_map
    SET state='unmapped', direction='none', erp_column=NULL, core_key=NULL,
        decided_by='backfill',
        decided_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE mirror_id=? AND (core_key=? OR erp_column=?) AND state='core'
  `).run(MIRROR, COLUMN, COLUMN).changes
}

// Une colonne droppée qui traîne dans visible_columns / sort / filters /
// color_rules / group_by / column_widths laisse une colonne fantôme dans la
// barre des vues. Une pastille qui ne filtrait QUE sur elle perd sa raison
// d'être : on la supprime au lieu de la laisser mentir.
function cleanSavedViews(d) {
  const dropped = new Set([COLUMN])
  const parse = (raw, fallback) => {
    try { return JSON.parse(raw || fallback) } catch { return JSON.parse(fallback) }
  }
  const keyOf = (x) => (typeof x === 'string' ? x : (x?.field ?? x?.id))
  const without = (arr) => arr.filter(x => !dropped.has(keyOf(x)))
  const withoutKeys = (obj) => Object.fromEntries(Object.entries(obj).filter(([k]) => !dropped.has(k)))
  let cleaned = 0, removedPills = 0

  const patchRow = (table, row, fields) => {
    const patch = {}
    for (const [col, kind] of Object.entries(fields)) {
      if (kind === 'list') {
        // `filters` a DEUX formes en base : le tableau de règles historique et
        // l'objet `{ conjunction, rules }` que la barre de filtres écrit
        // aujourd'hui. Traiter l'objet comme un tableau ferait un TypeError en
        // pleine transaction de migration.
        const raw = parse(row[col], '[]')
        const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.rules) ? raw.rules : [])
        if (!list.some(x => dropped.has(keyOf(x)))) continue
        patch[col] = JSON.stringify(
          Array.isArray(raw) ? without(raw) : { ...raw, rules: without(list) }
        )
      } else if (kind === 'map') {
        const map = parse(row[col], '{}')
        if (Object.keys(map).some(k => dropped.has(k))) patch[col] = JSON.stringify(withoutKeys(map))
      } else if (kind === 'scalar' && dropped.has(row[col])) {
        patch[col] = null
      }
    }
    if (!Object.keys(patch).length) return
    const sets = Object.keys(patch).map(k => `${k}=?`).join(', ')
    d.prepare(`UPDATE ${table} SET ${sets} WHERE id=?`).run(...Object.values(patch), row.id)
    cleaned++
  }

  for (const viewTable of VIEW_TABLES) {
    for (const row of d.prepare('SELECT * FROM table_view_pills WHERE table_name=?').all(viewTable)) {
      const raw = parse(row.filters, '[]')
      const rules = Array.isArray(raw) ? raw : (Array.isArray(raw?.rules) ? raw.rules : [])
      // Pastille dont TOUT le filtre reposait sur la colonne détruite.
      if (rules.length && rules.every(r => dropped.has(keyOf(r)))) {
        d.prepare('DELETE FROM table_view_pills WHERE id=?').run(row.id)
        removedPills++
        continue
      }
      patchRow('table_view_pills', row, {
        visible_columns: 'list', sort: 'list', filters: 'list', color_rules: 'list',
        column_widths: 'map', group_by: 'scalar',
      })
    }
    try {
      for (const row of d.prepare('SELECT * FROM table_view_configs WHERE table_name=?').all(viewTable)) {
        patchRow('table_view_configs', row, {
          visible_columns: 'list', default_sort: 'list',
          column_widths: 'map', footer_aggregations: 'map',
        })
      }
    } catch { /* table absente */ }
  }

  return { views_cleaned: cleaned, pills_removed: removedPills }
}
