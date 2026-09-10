/**
 * 036 — `purchases.qty_received` (« Qté reçue ») : suppression DÉFINITIVE.
 *
 * Demande depuis /champs/purchases : « supprime définitivement le champ Qté
 * reçue (drop column) ». Même voie que 023 / 028 / 029 / 030 / 032 / 033 / 035
 * (migration numérotée, tracée dans `schema_migrations`, appliquée au
 * `pm2 restart`).
 *
 * ── QUELLE colonne, exactement ────────────────────────────────────────────
 * Une seule rangée porte ce libellé sur /champs/purchases : la colonne NATIVE
 * `qty_received` (INTEGER, 1 922 valeurs non nulles sur 1 941), déclarée dans
 * `TABLE_COLUMN_META.purchases` (client) et laissée en place par 035 parce que
 * sa clé de field_map valait `null`. Aucun champ personnalisé homonyme (le test
 * de 030/033), aucune ligne `airtable_field_map`, aucun champ Airtable derrière.
 *
 * ── Ce que la table devient ───────────────────────────────────────────────
 * `purchases` n'a plus AUCUNE colonne native descriptive : il ne reste que
 * l'identité (`id`, `airtable_id`, `at_id`), le fournisseur
 * (`supplier_company_id` / `supplier_vendor_name` / `supplier_qb_vendor_id`),
 * `emplacement` et les horodatages. Tout le reste vit dans les champs
 * personnalisés pilotés depuis /champs/purchases — dont `qty_commandees_non_annulees`,
 * qui reste le seul compteur de quantité importé d'Airtable.
 *
 * ── Ce qu'il a fallu couper côté code (hors migration) ────────────────────
 *  • `db/schema.js` — la colonne sort du CREATE TABLE, sinon une base neuve la
 *    recréerait avant que la migration ne tourne (le piège de 026) ;
 *  • `routes/purchases.js` — POST (plus de quantité à la création), validation
 *    et `PATCHABLE_FIELDS` ;
 *  • `services/airtableMirrorEngine.js` — `achatsDerive` n'écrit plus la
 *    quantité reçue ; le plan cœur des achats était déjà vide (035) ;
 *  • `services/airtable.js` — `syncAchats` (repli legacy) : l'auto-détection du
 *    field_map disparaît (dernière clé, cf. le piège de 029) avec l'UPDATE et la
 *    colonne de l'INSERT ;
 *  • `client/src/lib/tableDefs.js`, `Purchases.jsx` (colonne + formulaire
 *    « Nouvel achat »), `PurchaseDetail.jsx`.
 *
 * ── Le filet ──────────────────────────────────────────────────────────────
 * Détruire les valeurs EST la demande : le garde-fou « colonne non vide » de 023
 * ne s'applique pas (cf. 028). Il est remplacé par une sauvegarde JSON dans
 * `uploads/backups/`, comme le fait `services/fieldPurge.js`.
 *
 * Défensive : chaque garde-fou renvoie `skipped` au lieu de lever — une
 * exception arrêterait le démarrage du serveur.
 */
import fs from 'node:fs'
import path from 'node:path'
import db from '../database.js'
import { regenerateView } from '../../services/customFieldsView.js'

export const id = '036-drop-purchases-qty-received'
export const description =
  'purchases : colonne qty_received (« Qté reçue ») droppée — plus aucune colonne native de quantité sur les achats'

const TABLE = 'purchases'
const COLUMN = 'qty_received'
const MIRROR = 'achats'
// Les vues sauvegardées sont rangées sous le nom de la RESSOURCE. Le tableau
// « Achats » d'une fiche pièce (`product_achats`) a disparu avec 035.
const VIEW_TABLES = ['purchases']

export function up(migrationDb) {
  const d = migrationDb || db

  const cols = new Set(d.pragma(`table_info(${TABLE})`).map(c => c.name))
  if (!cols.has(COLUMN)) return { skipped: 'colonne déjà absente' }

  // Un champ ressorti de la corbeille depuis /champs/purchases ne se détruit pas
  // dans son dos.
  const alive = d.prepare(
    `SELECT name FROM custom_fields WHERE erp_table=? AND column_name=? AND deleted_at IS NULL`
  ).get(TABLE, COLUMN)
  if (alive) return { skipped: `champ « ${alive.name} » redevenu actif` }

  // Un lookup / rollup d'une AUTRE table qui viserait la colonne serait vidé en
  // silence ; un rollup qui la prend pour FK ferait tomber sa vue en erreur.
  const dependent = d.prepare(
    `SELECT erp_table, name FROM custom_fields
      WHERE deleted_at IS NULL AND erp_table <> ?
        AND ((lookup_target_table=? AND lookup_target_column=?)
          OR (rollup_target_table=? AND rollup_target_column=?)
          OR (rollup_target_table=? AND rollup_target_fk=?))`
  ).get(TABLE, TABLE, COLUMN, TABLE, COLUMN, TABLE, COLUMN)
  if (dependent) return { skipped: `champ calculé dépendant : ${dependent.erp_table}.${dependent.name}` }

  // Une formule DE CETTE TABLE qui nomme la colonne tomberait en erreur de vue
  // au prochain rendu.
  const formula = d.prepare(
    `SELECT name FROM custom_fields
      WHERE deleted_at IS NULL AND erp_table=? AND kind='formula' AND formula_expr LIKE ?`
  ).get(TABLE, `%${COLUMN}%`)
  if (formula) return { skipped: `formule dépendante : ${TABLE}.${formula.name}` }

  // Si l'import Airtable a été branché sur la colonne entre temps, le sync
  // réécrirait une colonne disparue : on s'arrête.
  const mapped = d.prepare(
    `SELECT column_name FROM airtable_field_mappings
      WHERE erp_table=? AND column_name=? AND import_disabled IS NOT 1`
  ).get(TABLE, COLUMN)
  if (mapped) return { skipped: `import Airtable actif sur ${TABLE}.${COLUMN}` }

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
  const registry = releaseFromMirrorRegistry(d)
  const views = cleanSavedViews(d)

  regenerateView(TABLE)

  return {
    dropped: `${TABLE}.${COLUMN}`,
    backup,
    custom_fields_removed: fields,
    airtable_mappings_removed: mappings, airtable_defs_removed: defs,
    field_map_keys_removed: unmapped, mirror_rows_released: registry, ...views,
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
    console.warn(`[036] sauvegarde ${TABLE}.${COLUMN} impossible :`, e.message)
    return null
  }
}

// Le field_map « cœur » du miroir achats, stocké en JSON. Sa clé `qty_received`
// valait `null` (aucun champ Airtable derrière) : la retirer laisse un field_map
// VIDE, ce qui est exact — plus aucune colonne des achats n'est gérée en code.
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

// Registre du miroir : aucune ligne ne pointe sur cette colonne aujourd'hui (le
// champ n'a jamais eu de champ Airtable derrière), mais si l'une y était rangée
// entre temps, elle repasse en `unmapped` plutôt que de garder un `erp_column`
// pointant sur une colonne détruite. `excluded` serait faux : c'est la colonne
// ERP qu'on supprime, pas une décision de ne pas importer un champ Airtable.
function releaseFromMirrorRegistry(d) {
  return d.prepare(`
    UPDATE airtable_field_map
    SET state='unmapped', direction='none', erp_column=NULL, core_key=NULL,
        decided_by='backfill',
        decided_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE mirror_id=? AND (erp_column=? OR core_key=?)
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
