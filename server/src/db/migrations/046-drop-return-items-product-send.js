/**
 * 046 — « Produit à envoyer » (Articles de retour) : suppression DÉFINITIVE.
 *
 * Demande depuis /champs/return_items : « supprime la colonne Produit à envoyer
 * (drop column) ». Même voie que 023 / 028 / 030 : migration numérotée, tracée
 * dans `schema_migrations`, appliquée au `pm2 restart`.
 *
 * CE QUE LA LIGNE « Produit à envoyer » DÉSIGNE. Sur /champs/return_items elle
 * ne correspond pas à une colonne SQL homonyme : `product_to_send` est un ALIAS
 * de JOIN (`ps.name_fr`, routes/projets.js) qui n'affiche que le LIBELLÉ du
 * produit, et `tableDefs.js` rattachait la cellule « Champ Airtable » de cette
 * ligne à la vraie colonne par `mappingColumn: 'product_send_id'`. Détruire le
 * champ, c'est donc détruire la FK `return_items.product_send_id` (155 valeurs
 * sur 767) ET l'alias qui l'affichait — sans quoi la FK reprendrait aussitôt sa
 * propre ligne « colonne mappée non affichée ».
 *
 * CONSÉQUENCE ASSUMÉE. `services/returnItemCreatedWatcher.js` lisait cette FK
 * pour donner un produit à la commande de remplacement créée automatiquement
 * sur un « Retour de garantie avec échange immédiat » (133 des 278 articles
 * concernés la portaient). La ligne de commande naît désormais SANS produit :
 * la donnée qui le disait n'existe plus. Aucun repli n'était fiable — 147 des
 * 155 valeurs n'avaient pas de « produit à recevoir » en face, et le produit du
 * numéro de série différait dans 65 cas sur 149.
 *
 * Filet : sauvegarde JSON dans `uploads/backups/` avant destruction (recette
 * 028) — la destruction des valeurs FAIT partie de la demande, le garde-fou
 * « colonne non vide » de 023 ne s'applique donc pas.
 *
 * Sources à couper HORS migration (sinon le prochain sync écrit dans une
 * colonne disparue) : `CORE_PLANS.retour_items.fields` et
 * `WRITEBACK_MODULES.retour_items` (skipKeys / keyToColumn / linkedRecords),
 * `RETOUR_ITEMS_FIELD_MAP_PLAN` + ses tables cibles et options
 * (airtableUiFieldMap.js), le lecteur legacy de `syncRetourItems`
 * (airtable.js), l'`ALTER TABLE … ADD COLUMN` de schema.js (qui tourne AVANT
 * les migrations et recréerait la colonne sur une base neuve) et l'entrée
 * `tableDefs.js` côté client.
 *
 * Registres : le field_map cœur du module est déjà NULL (retiré le
 * 2026-09-08), le mapping vit dans `airtable_field_mappings`. Sa ligne reste,
 * passée en `import_disabled=1` — pierre tombale de la décision « ne pas
 * importer ce champ Airtable », qui rend aussi l'état « exclu » au registre du
 * miroir. Pas de `purged_fields` : la colonne sort aussi de `tableDefs.js`, la
 * pierre tombale serait elle-même une trace.
 *
 * Défensive : chaque garde-fou renvoie `skipped` au lieu de lever — une
 * exception arrêterait le démarrage du serveur.
 */
import fs from 'fs'
import path from 'path'
import db from '../database.js'
import { regenerateView } from '../../services/customFieldsView.js'

export const id = '046-drop-return-items-product-send'
export const description = 'return_items.product_send_id droppée — champ « Produit à envoyer » détruit'

const TABLE = 'return_items'
const COLUMN = 'product_send_id'
// L'alias de JOIN qui portait le libellé : il n'a pas de colonne SQL, mais bien
// une ligne custom_fields (à la corbeille) et une place possible dans les vues.
const ALIAS = 'product_to_send'
const MIRROR = 'retour_items'
const CORE_KEY = 'product_to_send'
// Les vues sauvegardées sont rangées sous le nom de la RESSOURCE : le tableau
// « Articles » de la fiche retour (`retour_items`) et la liste des retours.
const VIEW_TABLES = ['retour_items', 'retours']

export function up(migrationDb) {
  const d = migrationDb || db

  const cols = new Set(d.pragma(`table_info(${TABLE})`).map(c => c.name))
  if (!cols.has(COLUMN)) return { skipped: 'colonne déjà absente' }

  // Un champ remis en service depuis /champs/return_items ne se détruit pas
  // dans son dos.
  const alive = d.prepare(
    `SELECT name, column_name FROM custom_fields
      WHERE erp_table=? AND column_name IN (?,?) AND deleted_at IS NULL`
  ).get(TABLE, COLUMN, ALIAS)
  if (alive) return { skipped: `champ « ${alive.name || alive.column_name} » redevenu actif` }

  // Un lookup / rollup d'une autre table qui viserait la colonne serait vidé en
  // silence.
  const dependent = d.prepare(
    `SELECT erp_table, name FROM custom_fields
      WHERE deleted_at IS NULL
        AND ((lookup_target_table=? AND lookup_target_column IN (?,?))
          OR (rollup_target_table=? AND rollup_target_column IN (?,?))
          OR lookup_fk=? OR rollup_target_fk=?)`
  ).get(TABLE, COLUMN, ALIAS, TABLE, COLUMN, ALIAS, COLUMN, COLUMN)
  if (dependent) return { skipped: `champ calculé dépendant : ${dependent.erp_table}.${dependent.name}` }

  const backup = backupValues(d)

  d.exec(`DROP VIEW IF EXISTS ${TABLE}_v`)
  d.exec(`ALTER TABLE ${TABLE} DROP COLUMN [${COLUMN}]`)

  d.prepare(`DELETE FROM custom_fields WHERE erp_table=? AND column_name IN (?,?)`).run(TABLE, COLUMN, ALIAS)
  try {
    d.prepare(`DELETE FROM airtable_field_defs WHERE erp_table=? AND column_name IN (?,?)`).run(TABLE, COLUMN, ALIAS)
  } catch { /* table héritée absente */ }

  // Sens de synchronisation réglé champ par champ (aucun aujourd'hui : le
  // module est en `defaultDirection: 'pull'`), sous la clé cœur ou la clé
  // dynamique de la colonne.
  const directions = d.prepare(
    `DELETE FROM airtable_field_directions WHERE module=? AND field_key IN (?,?,?)`
  ).run(MIRROR, CORE_KEY, `dyn:${COLUMN}`, COLUMN).changes

  const tombstone = d.prepare(`
    UPDATE airtable_field_mappings
    SET import_disabled=1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE erp_table=? AND column_name=?
  `).run(TABLE, COLUMN).changes

  const excluded = excludeFromMirrorRegistry(d)
  const views = cleanSavedViews(d)

  regenerateView(TABLE)

  return {
    dropped: `${TABLE}.${COLUMN}`, backup,
    mapping_disabled: tombstone, directions_removed: directions,
    mirror_rows_excluded: excluded, ...views,
  }
}

// Sauvegarde des valeurs qu'on s'apprête à détruire (cf. fieldPurge.js).
function backupValues(d) {
  try {
    const dir = path.join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'backups')
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)
    const file = path.join(dir, `champs-purges-${TABLE}-${COLUMN}-${stamp}.json`)
    const rows = d.prepare(
      `SELECT id, [${COLUMN}] FROM ${TABLE} WHERE [${COLUMN}] IS NOT NULL`
    ).all()
    fs.writeFileSync(file, JSON.stringify(
      { table: TABLE, columns: [COLUMN], purged_at: new Date().toISOString(), rows }, null, 1))
    return file
  } catch (e) {
    console.warn(`[046] sauvegarde ${TABLE}.${COLUMN} impossible :`, e.message)
    return null
  }
}

// Registre du miroir : le champ Airtable « Produit à envoyer » existe toujours,
// il n'est simplement plus importé. `decided_by='user'` est la seule marque que
// le rafraîchissement du registre respecte — sans elle, le champ retomberait
// dans les « sans décision ».
function excludeFromMirrorRegistry(d) {
  return d.prepare(`
    UPDATE airtable_field_map
    SET state='excluded', direction='none', erp_column=NULL, core_key=NULL,
        exclude_reason=?, decided_by='user',
        decided_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE mirror_id=? AND (core_key=? OR erp_column=?)
  `).run('champ ERP supprimé — colonne droppée (migration 046)', MIRROR, CORE_KEY, COLUMN).changes
}

// Une colonne droppée qui traîne dans visible_columns / sort / filters /
// color_rules / group_by / column_widths laisse une colonne fantôme dans la
// barre des vues. Une pastille qui ne filtrait QUE sur elle perd sa raison
// d'être : on la supprime au lieu de la laisser mentir.
function cleanSavedViews(d) {
  const keys = new Set([COLUMN, ALIAS])
  const parse = (raw, fallback) => {
    try { return JSON.parse(raw || fallback) } catch { return JSON.parse(fallback) }
  }
  const keyOf = (x) => (typeof x === 'string' ? x : (x?.field ?? x?.id))
  const without = (arr) => arr.filter(x => !keys.has(keyOf(x)))
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
        if (!list.some(x => keys.has(keyOf(x)))) continue
        patch[col] = JSON.stringify(Array.isArray(raw) ? without(raw) : { ...raw, rules: without(list) })
      } else if (kind === 'map') {
        const map = parse(row[col], '{}')
        if (Object.keys(map).some(k => keys.has(k))) {
          patch[col] = JSON.stringify(Object.fromEntries(Object.entries(map).filter(([k]) => !keys.has(k))))
        }
      } else if (kind === 'scalar' && keys.has(row[col])) {
        patch[col] = null
      }
    }
    if (!Object.keys(patch).length) return
    const sets = Object.keys(patch).map(k => `${k}=?`).join(', ')
    d.prepare(`UPDATE ${table} SET ${sets} WHERE id=?`).run(...Object.values(patch), row.id)
    cleaned++
  }

  for (const viewTable of VIEW_TABLES) {
    for (const row of d.prepare(`SELECT * FROM table_view_pills WHERE table_name=?`).all(viewTable)) {
      const raw = parse(row.filters, '[]')
      const rules = Array.isArray(raw) ? raw : (Array.isArray(raw?.rules) ? raw.rules : [])
      // Pastille dont TOUT le filtre reposait sur la colonne détruite.
      if (rules.length && rules.every(r => keys.has(keyOf(r)))) {
        d.prepare(`DELETE FROM table_view_pills WHERE id=?`).run(row.id)
        removedPills++
        continue
      }
      patchRow('table_view_pills', row, {
        visible_columns: 'list', sort: 'list', filters: 'list', color_rules: 'list',
        column_widths: 'map', group_by: 'scalar',
      })
    }
    try {
      for (const row of d.prepare(`SELECT * FROM table_view_configs WHERE table_name=?`).all(viewTable)) {
        patchRow('table_view_configs', row, {
          visible_columns: 'list', default_sort: 'list',
          column_widths: 'map', footer_aggregations: 'map',
        })
      }
    } catch { /* table absente */ }
  }

  return { views_cleaned: cleaned, pills_removed: removedPills }
}
