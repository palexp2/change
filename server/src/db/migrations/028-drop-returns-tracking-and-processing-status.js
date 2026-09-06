/**
 * 028 — « Suivi » et « Statut de traitement » (Retours) : suppression DÉFINITIVE.
 *
 * Demande depuis /champs/retours : « supprime les champs Suivi et statut de
 * traitement — suppression totale (drop column) ». Même voie que 023 (migration
 * numérotée, pas de script one-shot), avec deux différences qui méritent d'être
 * dites :
 *
 *  1. `processing_status` N'EST PAS VIDE — 476 retours sur 476 le portent
 *     (« Analyse complétée » ×461, « En transit » ×10, « Aucun item à
 *     retourner » ×5). 023 s'arrêtait devant une colonne non vide ; ici la
 *     destruction des valeurs EST la demande. Le filet est donc une sauvegarde
 *     JSON dans `uploads/backups/`, comme le fait `services/fieldPurge.js`
 *     quand « Vider la corbeille » détruit une colonne `cf_*`.
 *     `tracking_number`, lui, est vide sur les 476 lignes.
 *
 *  2. les deux colonnes sont alimentées par le field_map « CŒUR » du miroir
 *     `retours` (« Status » et « Numéro de repérage fourni par le client »).
 *     Un DROP COLUMN sans toucher au mapping ferait échouer le sync suivant sur
 *     une colonne disparue. Il faut donc couper la source aux TROIS endroits où
 *     elle est déclarée :
 *       - `CORE_PLANS.retours.fields` (services/airtableMirrorEngine.js) et la
 *         fonction historique de `services/airtable.js` — hors migration ;
 *       - `airtable_module_config.field_map` (JSON en base) — ici ;
 *       - `airtable_field_map`, le registre du miroir — ici.
 *
 * Ce qui RESTE volontairement : les deux lignes `airtable_field_map`, passées de
 * `state='core'` à `state='excluded'` avec `decided_by='user'`. Ce n'est pas une
 * trace du champ ERP, c'est la décision « ne pas importer ce champ Airtable » —
 * les supprimer les ferait revenir en champs « sans décision » au prochain
 * rafraîchissement du registre (airtableMirrorRegistry.js : seul
 * `decided_by='user'` survit à l'upsert de backfill).
 *
 * Pas de `purged_fields` : les deux colonnes sortent aussi de `tableDefs.js`
 * côté client, donc aucune définition ne peut les faire réapparaître — la
 * pierre tombale serait elle-même une trace.
 *
 * Vues enregistrées : les deux pastilles de /retours nommaient ces colonnes.
 * « Tous les retours » les perd simplement. « En transit » n'existait QUE pour
 * filtrer `processing_status = 'En transit'` : privée de sa règle elle
 * afficherait les 476 retours sous une étiquette fausse, elle est donc
 * supprimée plutôt que vidée.
 *
 * Défensive : chaque garde-fou renvoie `skipped` au lieu de lever — une
 * exception arrêterait le démarrage du serveur.
 */
import fs from 'fs'
import path from 'path'
import db from '../database.js'
import { regenerateView } from '../../services/customFieldsView.js'

export const id = '028-drop-returns-tracking-and-processing-status'
export const description = 'returns.tracking_number et returns.processing_status droppées — champs « Suivi » et « Statut de traitement » détruits'

const TABLE = 'returns'
const COLUMNS = ['tracking_number', 'processing_status']
const MIRROR = 'retours'
// Les pastilles et configs de vue sont rangées sous le nom de la RESSOURCE
// (l'url), pas sous celui de la table SQL : /retours et le bloc « Retours » de
// la fiche entreprise.
const VIEW_TABLES = ['retours', 'company_retours']

export function up(migrationDb) {
  const d = migrationDb || db

  const cols = new Set(d.pragma(`table_info(${TABLE})`).map(c => c.name))
  const present = COLUMNS.filter(c => cols.has(c))
  if (!present.length) return { skipped: 'colonnes déjà absentes' }

  // Un champ remis en service depuis /champs/retours ne se détruit pas dans son dos.
  const alive = d.prepare(
    `SELECT name, column_name FROM custom_fields
      WHERE erp_table=? AND column_name IN (${present.map(() => '?').join(',')})
        AND deleted_at IS NULL`
  ).get(TABLE, ...present)
  if (alive) return { skipped: `champ « ${alive.name} » redevenu actif` }

  // Un lookup / rollup d'une autre table qui viserait l'une des colonnes serait
  // vidé en silence.
  for (const col of present) {
    const dependent = d.prepare(
      `SELECT erp_table, name FROM custom_fields
        WHERE deleted_at IS NULL
          AND ((lookup_target_table=? AND lookup_target_column=?)
            OR (rollup_target_table=? AND rollup_target_column=?))`
    ).get(TABLE, col, TABLE, col)
    if (dependent) return { skipped: `champ calculé dépendant : ${dependent.erp_table}.${dependent.name}` }
  }

  // Filet avant destruction : les valeurs partent sur disque. Best effort — un
  // disque plein ne doit pas empêcher le démarrage du serveur.
  const backup = backupValues(d, present)

  d.exec(`DROP VIEW IF EXISTS ${TABLE}_v`)
  for (const col of present) d.exec(`ALTER TABLE ${TABLE} DROP COLUMN [${col}]`)

  // Registres qui décrivaient les natifs. Aucun n'a de ligne aujourd'hui (les
  // deux champs étaient « cœur », donc hors du mapping champ-à-champ), mais une
  // migration qui suppose l'état de la base se trompe un jour.
  const ph = present.map(() => '?').join(',')
  d.prepare(`DELETE FROM custom_fields WHERE erp_table=? AND column_name IN (${ph})`).run(TABLE, ...present)
  d.prepare(`DELETE FROM airtable_field_mappings WHERE erp_table=? AND column_name IN (${ph})`).run(TABLE, ...present)
  try {
    d.prepare(`DELETE FROM airtable_field_defs WHERE erp_table=? AND column_name IN (${ph})`).run(TABLE, ...present)
  } catch { /* table héritée absente */ }

  const unmapped = removeFromLegacyFieldMap(d, present)
  const excluded = excludeFromMirrorRegistry(d, present)
  const views = cleanSavedViews(d, present)

  regenerateView(TABLE)

  return {
    dropped: present.map(c => `${TABLE}.${c}`),
    backup, field_map_keys_removed: unmapped, mirror_rows_excluded: excluded, ...views,
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
    fs.writeFileSync(file, JSON.stringify({ table: TABLE, columns, purged_at: new Date().toISOString(), rows }, null, 1))
    return file
  } catch (e) {
    console.warn(`[028] sauvegarde ${TABLE} impossible :`, e.message)
    return null
  }
}

// Le field_map « cœur » du miroir, stocké en JSON. Sa clé porte le nom de la
// colonne ERP : la retirer coupe l'import à la source.
function removeFromLegacyFieldMap(d, columns) {
  const row = d.prepare('SELECT field_map FROM airtable_module_config WHERE module=?').get(MIRROR)
  if (!row?.field_map) return 0
  let map
  try { map = JSON.parse(row.field_map) } catch { return 0 }
  const removed = columns.filter(c => Object.hasOwn(map, c))
  if (!removed.length) return 0
  for (const c of removed) delete map[c]
  // airtable_module_config n'a pas de colonne updated_at (cf. db/schema.js) :
  // l'y écrire faisait échouer la migration au démarrage.
  d.prepare('UPDATE airtable_module_config SET field_map=? WHERE module=?')
    .run(JSON.stringify(map), MIRROR)
  return removed.length
}

// Registre du miroir : le champ Airtable existe toujours, il n'est simplement
// plus importé. `decided_by='user'` est la seule marque que le rafraîchissement
// du registre respecte — sans elle, le champ redeviendrait « sans décision ».
function excludeFromMirrorRegistry(d, columns) {
  let n = 0
  for (const col of columns) {
    n += d.prepare(`
      UPDATE airtable_field_map
      SET state='excluded', direction='none', erp_column=NULL, core_key=NULL,
          exclude_reason=?, decided_by='user',
          decided_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE mirror_id=? AND (core_key=? OR erp_column=?)
    `).run('champ ERP supprimé — colonne droppée (migration 028)', MIRROR, col, col).changes
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
        // aujourd'hui. Traiter l'objet comme un tableau ferait un TypeError
        // en pleine transaction de migration.
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
