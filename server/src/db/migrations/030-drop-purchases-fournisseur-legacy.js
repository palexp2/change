/**
 * 030 — « Fournisseur - LEGACY » (Achats) : suppression DÉFINITIVE de la colonne.
 *
 * Demande depuis /champs/purchases : « drop column sur le champ Fournisseur -
 * LEGACY de la table Achats ». Même voie que 023 / 028 / 029 (migration
 * numérotée, tracée dans `schema_migrations`, appliquée au `pm2 restart`).
 *
 * ── QUELLE colonne, exactement ────────────────────────────────────────────
 * Le champ Airtable « Fournisseur - LEGACY » (fldTx4jWJ07LvhMBS) a DEUX
 * atterrissages dans `purchases`, et un seul est visé ici :
 *
 *  • `fournisseur_legacy` — la colonne ADOPTÉE (champ perso `source='airtable'`,
 *    single_select, 1 799 / 1 941 achats renseignés). C'est LA ligne que
 *    /champs/purchases affiche sous le libellé « Fournisseur - LEGACY » : mise à
 *    la corbeille le 2026-09-04, elle revient encore en `hidden:true` sur
 *    `GET /custom-fields/purchases/native`. C'est elle qu'on droppe.
 *
 *  • `supplier` — la colonne NATIVE, libellée « Fournisseur » côté client
 *    (`TABLE_COLUMN_META`), à laquelle le field_map CŒUR du miroir achats mappe
 *    le même champ Airtable (`"supplier": "Fournisseur - LEGACY"`). On n'y
 *    touche PAS : elle porte 1 937 valeurs et une dizaine de consommateurs
 *    serveur (création d'un achat dans `routes/purchases.js`, sous-titre de
 *    `services/recordLinks.js`, `scripts/resolve-purchases-supplier.js`,
 *    `schema.js` via `supplier_company_id`…). Le miroir continue donc de la
 *    remplir — `achatsDerive` en fait le repli du fournisseur LIÉ
 *    (`supplier: legacySupplier || vendor?.name`), cf. airtableMirrorEngine.js.
 *    Autrement dit : ni `CORE_PLANS.achats.fields`, ni `syncAchats`
 *    (services/airtable.js), ni la clé `supplier` du JSON
 *    `airtable_module_config.field_map` ne bougent — contrairement à 028/029,
 *    où la colonne détruite ÉTAIT la cible du plan cœur.
 *
 * ── Ce qui rend le DROP sûr ───────────────────────────────────────────────
 * `fournisseur_legacy` n'a AUCUN consommateur : zéro occurrence dans
 * `server/src` comme dans `client/src`, aucun lookup/rollup ni formule qui la
 * vise, aucune automatisation, aucune entrée `detail_field_configs`. Son import
 * est déjà coupé (`airtable_field_mappings.import_disabled = 1`), et tous les
 * chemins d'écriture du sync filtrent là-dessus (airtableAutoSync.js,
 * airtableUiFieldMap.js, airtableWriteback.js) : le prochain sync n'essaiera pas
 * d'écrire dans une colonne disparue.
 *
 * ── Le filet ──────────────────────────────────────────────────────────────
 * Détruire 1 799 valeurs EST la demande : le garde-fou « valeurs non vides » de
 * 023 ne s'applique pas (cf. 028). Il est remplacé par une sauvegarde JSON dans
 * `uploads/backups/`, comme le fait `services/fieldPurge.js` — la corbeille
 * n'aura plus rien à restaurer.
 *
 * ── Ce qui reste volontairement ───────────────────────────────────────────
 * La ligne `airtable_field_mappings` en `import_disabled=1`, avec son ancien
 * `column_name` : c'est elle — et elle seule — qui fait afficher le champ
 * Airtable comme « désactivé » plutôt que « disponible à l'import ». La
 * supprimer le ferait revenir dans la liste, et un clic recréerait colonne +
 * champ. Ce n'est pas une trace du champ ERP, c'est la décision « ne pas
 * importer ce champ Airtable ». Pas de `purged_fields` non plus : la colonne
 * n'est ni dans `tableDefs.js` ni dans un `CORE_FIELD_SPECS`, la pierre tombale
 * serait elle-même une trace.
 *
 * Défensive : chaque garde-fou renvoie `skipped` au lieu de lever — une
 * exception arrêterait le démarrage du serveur.
 */
import fs from 'node:fs'
import path from 'node:path'
import db from '../database.js'
import { regenerateView } from '../../services/customFieldsView.js'

export const id = '030-drop-purchases-fournisseur-legacy'
export const description =
  'purchases.fournisseur_legacy droppée — champ « Fournisseur - LEGACY » des achats détruit (la native `supplier` reste)'

const TABLE = 'purchases'
const COLUMN = 'fournisseur_legacy'
const MIRROR = 'achats'
// Les vues sauvegardées sont rangées sous le nom de la RESSOURCE : /purchases
// et le tableau « Achats » de la fiche pièce (cf. TABLE_COLUMN_META).
const VIEW_TABLES = ['purchases', 'product_achats']

export function up(migrationDb) {
  const d = migrationDb || db

  const cols = new Set(d.pragma(`table_info(${TABLE})`).map(c => c.name))
  if (!cols.has(COLUMN)) return { skipped: 'colonne déjà absente' }

  // Un champ ressorti de la corbeille depuis /champs/purchases ne se détruit
  // pas dans son dos.
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

  // Une formule qui nomme la colonne tomberait en erreur de vue au prochain rendu.
  const formula = d.prepare(
    `SELECT erp_table, name FROM custom_fields
      WHERE deleted_at IS NULL AND formula_expr LIKE ?`
  ).get(`%${COLUMN}%`)
  if (formula) return { skipped: `formule dépendante : ${formula.erp_table}.${formula.name}` }

  // Si l'import a été rallumé entre-temps, le sync réécrirait la colonne : on
  // s'arrête plutôt que de le faire échouer au prochain passage.
  const reenabled = d.prepare(
    `SELECT id FROM airtable_field_mappings
      WHERE erp_table=? AND column_name=? AND import_disabled IS NOT 1`
  ).get(TABLE, COLUMN)
  if (reenabled) return { skipped: 'import Airtable réactivé sur ce champ' }

  const backup = backupValues(d)

  d.exec(`DROP VIEW IF EXISTS ${TABLE}_v`)
  d.exec(`ALTER TABLE ${TABLE} DROP COLUMN [${COLUMN}]`)

  // La ligne `custom_fields` soft-supprimée (celle de la corbeille) et la
  // définition héritée. Le mapping, lui, RESTE en import_disabled=1 : voir l'en-tête.
  const fields = d.prepare(`DELETE FROM custom_fields WHERE erp_table=? AND column_name=?`)
    .run(TABLE, COLUMN).changes
  let defs = 0
  try {
    defs = d.prepare(`DELETE FROM airtable_field_defs WHERE erp_table=? AND column_name=?`)
      .run(TABLE, COLUMN).changes
  } catch { /* table héritée absente */ }

  const excluded = excludeFromMirrorRegistry(d)
  const views = cleanSavedViews(d)

  regenerateView(TABLE)

  return {
    dropped: `${TABLE}.${COLUMN}`,
    backup, custom_fields_removed: fields, airtable_defs_removed: defs,
    mirror_rows_excluded: excluded, ...views,
  }
}

// Sauvegarde des valeurs qu'on s'apprête à détruire (cf. fieldPurge.js).
function backupValues(d) {
  try {
    const dir = path.join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'backups')
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)
    const file = path.join(dir, `champs-purges-${TABLE}-${stamp}.json`)
    const rows = d.prepare(`SELECT id, [${COLUMN}] FROM ${TABLE}`).all()
    fs.writeFileSync(file, JSON.stringify(
      { table: TABLE, columns: [COLUMN], purged_at: new Date().toISOString(), rows }, null, 1))
    return file
  } catch (e) {
    console.warn(`[030] sauvegarde ${TABLE} impossible :`, e.message)
    return null
  }
}

// Registre du miroir : le champ Airtable « Fournisseur - LEGACY » existe
// toujours, il n'est simplement plus adopté comme colonne à lui. On ne cible
// QUE la ligne dont `erp_column` est la colonne détruite — la clé cœur
// `supplier` (colonne survivante) ne doit pas être touchée.
// `decided_by='user'` est la seule marque que le rafraîchissement du registre
// respecte ; sans elle le champ pourrait repasser « sans décision ».
function excludeFromMirrorRegistry(d) {
  return d.prepare(`
    UPDATE airtable_field_map
    SET state='excluded', direction='none', erp_column=NULL, core_key=NULL,
        exclude_reason=?, decided_by='user',
        decided_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE mirror_id=? AND erp_column=?
  `).run('champ ERP supprimé — colonne droppée (migration 030)', MIRROR, COLUMN).changes
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
