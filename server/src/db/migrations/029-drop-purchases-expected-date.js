/**
 * 029 — « Date prévue » (Achats) : suppression DÉFINITIVE.
 *
 * Demande depuis /champs/purchases : « supprime le champ Date prévue de la table
 * Achats, suppression complète, drop column ». Même voie que 023 et 028
 * (migration numérotée, tracée dans `schema_migrations`, appliquée au
 * `pm2 restart`) — pas un script one-shot.
 *
 * Ce cas est le plus simple de la série : la colonne est VIDE sur les 1 941
 * achats (0 valeur non nulle), aucun champ perso ne la double, aucun
 * lookup/rollup ne la vise, aucune formule ni automatisation ne la nomme,
 * aucune pastille de vue ne la range dans ses colonnes ou ses filtres. Une
 * sauvegarde JSON comme celle de 028 n'aurait rien à écrire.
 *
 * Côté miroir Airtable, elle était déclarée « cœur » pour le module achats mais
 * jamais résolue : `airtable_module_config.field_map` porte
 * `"expected_date": null` (« Non mappé » sur /champs/purchases) et le registre
 * `airtable_field_map` n'a aucune ligne qui la vise. Il reste malgré tout deux
 * sources à couper hors migration, sinon le prochain sync écrirait dans une
 * colonne disparue : `CORE_PLANS.achats.fields` (services/airtableMirrorEngine.js)
 * et la fonction historique `syncAchats` (services/airtable.js) — dont
 * l'auto-détection ré-écrirait aussi la clé dans le JSON à chaque sync complet.
 *
 * Pas de `purged_fields` ni de ligne « tombstone » : la colonne sort aussi de
 * `tableDefs.js` côté client et n'apparaît dans aucun registre Airtable — la
 * pierre tombale serait elle-même une trace.
 *
 * Défensive : chaque garde-fou renvoie `skipped` au lieu de lever — une
 * exception arrêterait le démarrage du serveur.
 */
import db from '../database.js'
import { regenerateView } from '../../services/customFieldsView.js'

export const id = '029-drop-purchases-expected-date'
export const description = 'purchases.expected_date droppée — champ « Date prévue » des achats détruit'

const TABLE = 'purchases'
const COLUMN = 'expected_date'
const MIRROR = 'achats'
// Les vues sauvegardées sont rangées sous le nom de la RESSOURCE : /purchases
// et le tableau « Achats » de la fiche pièce (cf. TABLE_COLUMN_META).
const VIEW_TABLES = ['purchases', 'product_achats']

export function up(migrationDb) {
  const d = migrationDb || db

  const cols = new Set(d.pragma(`table_info(${TABLE})`).map(c => c.name))
  if (!cols.has(COLUMN)) return { skipped: 'colonne déjà absente' }

  // Un champ remis en service depuis /champs/purchases ne se détruit pas dans son dos.
  const alive = d.prepare(
    `SELECT name FROM custom_fields WHERE erp_table=? AND column_name=? AND deleted_at IS NULL`
  ).get(TABLE, COLUMN)
  if (alive) return { skipped: `champ « ${alive.name} » redevenu actif` }

  // Un lookup / rollup d'une autre table qui viserait la colonne serait vidé en silence.
  const dependent = d.prepare(
    `SELECT erp_table, name FROM custom_fields
      WHERE deleted_at IS NULL
        AND ((lookup_target_table=? AND lookup_target_column=?)
          OR (rollup_target_table=? AND rollup_target_column=?))`
  ).get(TABLE, COLUMN, TABLE, COLUMN)
  if (dependent) return { skipped: `champ calculé dépendant : ${dependent.erp_table}.${dependent.name}` }

  // La colonne est vide aujourd'hui ; si des valeurs sont réapparues entre-temps
  // (un sync, un import), on s'arrête plutôt que de les détruire en silence.
  const filled = d.prepare(
    `SELECT COUNT(*) c FROM ${TABLE} WHERE TRIM(COALESCE([${COLUMN}],'')) <> ''`
  ).get().c
  if (filled) return { skipped: `${filled} achat(s) portent une date prévue` }

  d.exec(`DROP VIEW IF EXISTS ${TABLE}_v`)
  d.exec(`ALTER TABLE ${TABLE} DROP COLUMN [${COLUMN}]`)

  // Registres qui pouvaient décrire le natif. Aucun n'a de ligne aujourd'hui,
  // mais une migration qui suppose l'état de la base se trompe un jour.
  d.prepare(`DELETE FROM custom_fields WHERE erp_table=? AND column_name=?`).run(TABLE, COLUMN)
  d.prepare(`DELETE FROM airtable_field_mappings WHERE erp_table=? AND column_name=?`).run(TABLE, COLUMN)
  try {
    d.prepare(`DELETE FROM airtable_field_defs WHERE erp_table=? AND column_name=?`).run(TABLE, COLUMN)
  } catch { /* table héritée absente */ }

  const unmapped = removeFromLegacyFieldMap(d)
  const excluded = excludeFromMirrorRegistry(d)
  const views = cleanSavedViews(d)

  regenerateView(TABLE)

  return { dropped: `${TABLE}.${COLUMN}`, field_map_keys_removed: unmapped, mirror_rows_excluded: excluded, ...views }
}

// Le field_map « cœur » du miroir, stocké en JSON. Sa clé porte le nom de la
// colonne ERP : la retirer coupe l'import à la source. La valeur est `null`
// (champ jamais mappé), mais la clé suffirait à faire réapparaître la ligne.
function removeFromLegacyFieldMap(d) {
  const row = d.prepare('SELECT field_map FROM airtable_module_config WHERE module=?').get(MIRROR)
  if (!row?.field_map) return 0
  let map
  try { map = JSON.parse(row.field_map) } catch { return 0 }
  if (!Object.hasOwn(map, COLUMN)) return 0
  delete map[COLUMN]
  // airtable_module_config n'a pas de colonne updated_at (cf. db/schema.js) :
  // l'y écrire ferait échouer la migration au démarrage.
  d.prepare('UPDATE airtable_module_config SET field_map=? WHERE module=?').run(JSON.stringify(map), MIRROR)
  return 1
}

// Registre du miroir : s'il existait une ligne, le champ Airtable existe
// toujours, il n'est simplement plus importé. `decided_by='user'` est la seule
// marque que le rafraîchissement du registre respecte.
function excludeFromMirrorRegistry(d) {
  return d.prepare(`
    UPDATE airtable_field_map
    SET state='excluded', direction='none', erp_column=NULL, core_key=NULL,
        exclude_reason=?, decided_by='user',
        decided_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE mirror_id=? AND (core_key=? OR erp_column=?)
  `).run('champ ERP supprimé — colonne droppée (migration 029)', MIRROR, COLUMN, COLUMN).changes
}

// Une colonne droppée qui traîne dans visible_columns / sort / filters /
// color_rules / group_by / column_widths laisse une colonne fantôme dans la
// barre des vues. Une pastille qui ne filtrait QUE sur elle perd sa raison
// d'être : on la supprime au lieu de la laisser mentir.
function cleanSavedViews(d) {
  const parse = (raw, fallback) => {
    try { return JSON.parse(raw || fallback) } catch { return JSON.parse(fallback) }
  }
  const keyOf = (x) => (typeof x === 'string' ? x : (x?.field ?? x?.id))
  const without = (arr) => arr.filter(x => keyOf(x) !== COLUMN)
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
        if (!list.some(x => keyOf(x) === COLUMN)) continue
        patch[col] = JSON.stringify(Array.isArray(raw) ? without(raw) : { ...raw, rules: without(list) })
      } else if (kind === 'map') {
        const map = parse(row[col], '{}')
        if (Object.hasOwn(map, COLUMN)) {
          patch[col] = JSON.stringify(Object.fromEntries(Object.entries(map).filter(([k]) => k !== COLUMN)))
        }
      } else if (kind === 'scalar' && row[col] === COLUMN) {
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
      if (rules.length && rules.every(r => keyOf(r) === COLUMN)) {
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
