/**
 * 045 — Trois des cinq champs Airtable « codés en dur » des Entreprises :
 * suppression DÉFINITIVE.
 *
 * Demande depuis /champs/companies : « supprime tous les champs codés en dur
 * (Entreprise, Phone number, URL, Type, Phase du cycle de vie) drop column ».
 * Même voie que 023 / 028 / 029 / 030 / 032 / 033 / 035 / 037 / 040 (migration
 * numérotée, tracée dans `schema_migrations`, appliquée au `pm2 restart`).
 *
 * ── QUELLES colonnes, exactement ──────────────────────────────────────────
 * La note « N champs Airtable gérés en code » au bas de /champs/companies liste
 * les valeurs STRING du field_map du module `companies`. Contrairement aux
 * autres modules, il ne vit PAS dans `airtable_module_config` mais dans
 * `airtable_sync_config.field_map_companies` (colonne dédiée du CRM) :
 *
 *   name             « Entreprise »           → companies.name           (6 656/6 656)
 *   phone            « Phone number »         → companies.phone          (4 393/6 656)
 *   website          « URL »                  → companies.website        (4 462/6 656)
 *   domain           « URL »                  → (colonne déjà absente)
 *   type             « Type »                 → companies.type           (5 100/6 656)
 *   lifecycle_phase  « Phase du cycle de vie » → companies.lifecycle_phase (5 971/6 656)
 *
 * Cette migration en détruit TROIS : `phone`, `website` et `type` (plus la clé
 * morte `domain`, dont la colonne n'existe plus depuis longtemps). `name` et
 * `lifecycle_phase` restent EN PLACE et gardent leur clé de field_map : chacune
 * porte une décision qui n'appartient pas au code —
 *   • `name` est l'identité de l'entreprise : 3 champs calculés la lisent en
 *     lookup (orders/serial_numbers/tasks « Entreprise »), le moteur de miroir
 *     en fait sa condition d'existence (`require: ['name']`), et une bonne
 *     partie de l'app affiche un nom d'entreprise ;
 *   • `lifecycle_phase` est le SEUL filtre de la file de relance des appels de
 *     qualification (« Quote Sent »), et sert de définition de « client » à la
 *     carte du tableau de bord et au suivi d'installation.
 * Les détruire suppose de décider ce que deviennent ces fonctions : la question
 * est posée à l'utilisateur plutôt que tranchée ici.
 *
 * ── Ce que la table devient ───────────────────────────────────────────────
 * Une entreprise n'a plus de téléphone, de site web ni de type côté colonnes
 * NATIVES. Les trois champs Airtable redeviennent mappables depuis
 * /champs/companies, vers les colonnes que l'utilisateur choisira — leurs
 * valeurs vivent toujours dans Airtable.
 *
 * ── Ce qu'il a fallu couper côté code (hors migration) ────────────────────
 *  • `routes/companies.js` — filtre `?type=`, recherche par téléphone,
 *    création et PATCH réduits aux colonnes survivantes ;
 *  • `routes/search.js` — la recherche globale ne cherche plus une entreprise
 *    par téléphone ni par site web (nom seul) ;
 *  • `utils/duplicateMatch.js` — plus de rapprochement par téléphone à la
 *    création d'une entreprise (nom et courriel restent) ;
 *  • `services/airtableMirrorEngine.js` (plan cœur `companies` : `phone` et
 *    `website` retirés, `derive` réduit à la phase), `services/airtable.js`
 *    (`syncCompanies` historique), `db/schema.js` ;
 *  • côté client `tableDefs.js`, `Companies.jsx`, `CompanyDetail.jsx`,
 *    `VendorSelect.jsx`.
 *
 * ── Le filet ──────────────────────────────────────────────────────────────
 * Détruire les valeurs EST la demande : le garde-fou « colonne non vide » de
 * 023 ne s'applique pas (cf. 028). Il est remplacé par une sauvegarde JSON
 * dans `uploads/backups/`, comme le fait `services/fieldPurge.js`.
 *
 * Deux particularités par rapport à 040 :
 *  • les trois colonnes portent DÉJÀ une ligne `airtable_field_mappings`
 *    (jumelle dormante semée par l'import webhook). Elle est inerte tant que
 *    la colonne appartient au field_map cœur — `syncDynamicFields` l'écarte
 *    sauf `share_core_field` (cf. airtableAutoSync.js). Le garde-fou « import
 *    actif » ne regarde donc que ce drapeau, sinon la migration se serait
 *    arrêtée sur des lignes qui n'écrivent rien ;
 *  • `detail_field_configs` (disposition de la fiche) cite les clés une à une :
 *    sans nettoyage, la fiche entreprise garderait trois entrées fantômes.
 *
 * Défensive : chaque garde-fou renvoie `skipped` au lieu de lever — une
 * exception arrêterait le démarrage du serveur.
 */
import fs from 'node:fs'
import path from 'node:path'
import db from '../database.js'
import { regenerateView } from '../../services/customFieldsView.js'

// Même lecture que `sharesCoreField` (services/airtableAutoSync.js), recopiée
// pour ne pas tirer tout le service de sync dans le démarrage des migrations.
function sharesCoreField(def) {
  try { return JSON.parse(def?.options || '{}').share_core_field === true }
  catch { return false }
}

export const id = '045-drop-companies-core-columns'
export const description =
  'companies : phone, website et type droppées — « Phone number », « URL » et « Type » redeviennent mappables dans /champs/companies'

const TABLE = 'companies'
const COLUMNS = ['phone', 'website', 'type']
// Clés du field_map cœur à retirer. `domain` visait « URL » comme `website`,
// mais sa colonne n'existe plus : la clé partait sinon en orpheline.
// `type_choices` est la table de correspondance des types, sans objet une fois
// `type` détruite. `name` et `lifecycle_phase` (+ `phase_choices`) RESTENT.
const CORE_KEYS = ['phone', 'website', 'domain', 'type', 'type_choices']
// Colonne déjà absente, mais dont la ligne de champ perso (à la corbeille) et
// la ligne de mapping traînent encore : « URL » est détruit pour de bon.
const DEAD_COLUMNS = ['domain']
// Les vues sauvegardées sont rangées sous le nom de la RESSOURCE. Seule
// /entreprises expose ces colonnes (les tableaux embarqués de la fiche
// entreprise portent d'autres tables).
const VIEW_TABLES = ['companies']

export function up(migrationDb) {
  const d = migrationDb || db

  const cols = new Set(d.pragma(`table_info(${TABLE})`).map(c => c.name))
  const present = COLUMNS.filter(c => cols.has(c))
  if (!present.length) return { skipped: 'colonnes déjà absentes' }

  // Un lookup / rollup d'une AUTRE table qui viserait l'une des colonnes serait
  // vidé en silence.
  for (const col of present) {
    const dependent = d.prepare(
      `SELECT erp_table, name FROM custom_fields
        WHERE deleted_at IS NULL AND erp_table <> ?
          AND ((lookup_target_table=? AND lookup_target_column=?)
            OR (rollup_target_table=? AND rollup_target_column=?))`
    ).get(TABLE, TABLE, col, TABLE, col)
    if (dependent) return { skipped: `champ calculé dépendant : ${dependent.erp_table}.${dependent.name}` }
  }

  // Un rollup d'une autre table qui passerait par l'une des colonnes comme clé
  // étrangère : la vue de CETTE table-là tomberait en erreur.
  const rollupFk = d.prepare(
    `SELECT erp_table, name FROM custom_fields
      WHERE deleted_at IS NULL AND rollup_target_table=? AND rollup_target_fk IN (${present.map(() => '?').join(',')})`
  ).get(TABLE, ...present)
  if (rollupFk) return { skipped: `rollup dépendant : ${rollupFk.erp_table}.${rollupFk.name}` }

  // Une formule DE CETTE TABLE qui nomme l'une des colonnes tomberait en erreur
  // de vue au prochain rendu.
  for (const col of present) {
    const formula = d.prepare(
      `SELECT name FROM custom_fields
        WHERE deleted_at IS NULL AND erp_table=? AND kind='formula' AND formula_expr LIKE ?`
    ).get(TABLE, `%${col}%`)
    if (formula) return { skipped: `formule dépendante : ${TABLE}.${formula.name}` }
  }

  // Une def dynamique qui PARTAGE explicitement le champ cœur écrit bel et bien
  // la colonne : le sync suivant viserait une colonne disparue. Les jumelles
  // dormantes (sans `share_core_field`) sont inertes et seront supprimées.
  const twins = d.prepare(
    `SELECT column_name, options FROM airtable_field_mappings
      WHERE erp_table=? AND column_name IN (${present.map(() => '?').join(',')})
        AND import_disabled IS NOT 1`
  ).all(TABLE, ...present)
  const active = twins.find(t => sharesCoreField(t))
  if (active) return { skipped: `import Airtable actif sur ${TABLE}.${active.column_name}` }

  const backup = backupValues(d, present)

  d.exec(`DROP VIEW IF EXISTS ${TABLE}_v`)
  const indexes = dropDependentIndexes(d, present)
  for (const col of present) d.exec(`ALTER TABLE ${TABLE} DROP COLUMN [${col}]`)

  const purged = [...present, ...DEAD_COLUMNS]
  const ph = purged.map(() => '?').join(',')
  const fields = d.prepare(`DELETE FROM custom_fields WHERE erp_table=? AND column_name IN (${ph})`)
    .run(TABLE, ...purged).changes
  const mappings = d.prepare(`DELETE FROM airtable_field_mappings WHERE erp_table=? AND column_name IN (${ph})`)
    .run(TABLE, ...purged).changes
  let defs = 0
  try {
    defs = d.prepare(`DELETE FROM airtable_field_defs WHERE erp_table=? AND column_name IN (${ph})`)
      .run(TABLE, ...purged).changes
  } catch { /* table héritée absente */ }

  const unmapped = removeFromCrmFieldMap(d)
  const released = releaseMirrorRegistry(d)
  const views = cleanSavedViews(d, purged)
  const detail = cleanDetailLayout(d, purged)

  regenerateView(TABLE)

  return {
    dropped: present.map(c => `${TABLE}.${c}`),
    backup, indexes_dropped: indexes,
    custom_fields_removed: fields,
    airtable_mappings_removed: mappings, airtable_defs_removed: defs,
    field_map_keys_removed: unmapped, mirror_rows_released: released,
    detail_layout_keys_removed: detail, ...views,
  }
}

// Sauvegarde des valeurs qu'on s'apprête à détruire (cf. fieldPurge.js).
function backupValues(d, columns) {
  try {
    const dir = path.join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'backups')
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)
    const file = path.join(dir, `champs-purges-${TABLE}-${stamp}.json`)
    const rows = d.prepare(`SELECT id, ${columns.map(c => `[${c}]`).join(', ')} FROM ${TABLE}`).all()
    fs.writeFileSync(file, JSON.stringify(
      { table: TABLE, columns, purged_at: new Date().toISOString(), rows }, null, 1))
    return file
  } catch (e) {
    console.warn(`[045] sauvegarde ${TABLE} impossible :`, e.message)
    return null
  }
}

// SQLite refuse `ALTER TABLE … DROP COLUMN` tant qu'un index porte la colonne.
// On les lit du schéma plutôt que de les nommer : un index oublié arrêterait le
// démarrage.
function dropDependentIndexes(d, columns) {
  const dropped = new Set(columns)
  const names = []
  for (const idx of d.pragma(`index_list(${TABLE})`)) {
    if (idx.origin !== 'c') continue      // 'pk' / 'u' : contraintes, pas des index nommés
    const cols = d.pragma(`index_info(${idx.name})`).map(c => c.name)
    if (cols.some(c => dropped.has(c))) {
      d.exec(`DROP INDEX IF EXISTS [${idx.name}]`)
      names.push(idx.name)
    }
  }
  return names
}

// Le field_map « cœur » du CRM, stocké en JSON dans une colonne dédiée de
// `airtable_sync_config` (pas dans `airtable_module_config` comme les autres
// modules). Retirer ses clés coupe l'import à la source ET retire les trois
// champs de la note « champs Airtable gérés en code » de /champs/companies, qui
// n'est que la liste de ses valeurs string.
function removeFromCrmFieldMap(d) {
  const row = d.prepare('SELECT field_map_companies FROM airtable_sync_config').get()
  if (!row?.field_map_companies) return 0
  let map
  try { map = JSON.parse(row.field_map_companies) } catch { return 0 }
  const removed = CORE_KEYS.filter(k => Object.hasOwn(map, k))
  if (!removed.length) return 0
  for (const k of removed) delete map[k]
  // airtable_sync_config n'a pas de colonne updated_at (cf. db/schema.js) :
  // l'y écrire ferait échouer la migration au démarrage.
  d.prepare('UPDATE airtable_sync_config SET field_map_companies=?').run(JSON.stringify(map))
  return removed.length
}

// Registre du miroir, scopé au miroir `companies`. Les lignes visées sont en
// `state='core'` : elles repassent en `unmapped` — PAS en `excluded`. Le champ
// Airtable existe toujours et l'utilisateur peut vouloir le (re)mapper depuis
// /champs/companies, c'est précisément ce que la demande rend possible.
function releaseMirrorRegistry(d) {
  let n = 0
  for (const key of CORE_KEYS) {
    n += d.prepare(`
      UPDATE airtable_field_map
      SET state='unmapped', direction='none', erp_column=NULL, core_key=NULL,
          decided_by='backfill',
          decided_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE mirror_id=? AND core_key=? AND state='core'
    `).run(TABLE, key).changes
  }
  return n
}

// Une colonne droppée qui traîne dans visible_columns / sort / filters /
// color_rules / group_by / column_widths laisse une colonne fantôme dans la
// barre des vues. Une pastille qui ne filtrait QUE sur elle perd sa raison
// d'être : on la supprime au lieu de la laisser mentir.
function cleanSavedViews(d, columns) {
  const dropped = new Set(columns)
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
      } else if (kind === 'scalar_or_list') {
        // `group_by` vaut soit une colonne, soit un JSON de plusieurs colonnes
        // (regroupement à plusieurs niveaux) : la pastille « Sources » de
        // /entreprises en a deux.
        const raw = row[col]
        if (!raw) continue
        if (dropped.has(raw)) { patch[col] = null; continue }
        if (typeof raw === 'string' && raw.trim().startsWith('[')) {
          const list = parse(raw, '[]')
          if (Array.isArray(list) && list.some(x => dropped.has(keyOf(x)))) {
            const kept = without(list)
            patch[col] = kept.length ? JSON.stringify(kept) : null
          }
        }
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
      // Pastille dont TOUT le filtre reposait sur une colonne détruite.
      if (rules.length && rules.every(r => dropped.has(keyOf(r)))) {
        d.prepare(`DELETE FROM table_view_pills WHERE id=?`).run(row.id)
        removedPills++
        continue
      }
      patchRow('table_view_pills', row, {
        visible_columns: 'list', sort: 'list', filters: 'list', color_rules: 'list',
        column_widths: 'map', group_by: 'scalar_or_list',
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

// Disposition de la FICHE entreprise (ordre et visibilité des champs, réglés
// par « Modifier la fiche ») : une clé détruite y resterait comme une ligne
// fantôme au prochain rendu.
function cleanDetailLayout(d, columns) {
  const dropped = new Set(columns)
  let removed = 0
  try {
    const row = d.prepare('SELECT id, field_order FROM detail_field_configs WHERE entity_type=?').get(TABLE)
    if (!row?.field_order) return 0
    let list
    try { list = JSON.parse(row.field_order) } catch { return 0 }
    if (!Array.isArray(list)) return 0
    const kept = list.filter(f => !dropped.has(typeof f === 'string' ? f : f?.key))
    removed = list.length - kept.length
    if (removed) {
      d.prepare('UPDATE detail_field_configs SET field_order=? WHERE id=?')
        .run(JSON.stringify(kept), row.id)
    }
  } catch { /* table absente */ }
  return removed
}
