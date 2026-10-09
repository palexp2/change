// Purge RÉELLE d'un champ — ce qu'exécute « Vider la corbeille ».
//
// Un champ supprimé est une ligne `custom_fields` soft-supprimée. La détruire
// naïvement ne purgeait rien, pour deux raisons opposées :
//
//   - champ NATIF ou ADOPTÉ (colonne sans préfixe `cf_`) : la ligne supprimée
//     EST la pierre tombale. Sa définition vit dans `tableDefs.js` côté client
//     et `GET /custom-fields/:table/native` republie les lignes supprimées en
//     `hidden: true`. Détruire la ligne faisait donc REVENIR le champ sur
//     toutes les fiches. Ici, la pierre tombale est transférée dans
//     `purged_fields`, qui survit à la purge → le champ ne revient jamais.
//     La colonne SQL reste : des routes, des syncs et des automatisations la
//     lisent, on ne peut pas la dropper sans casser le serveur.
//
//   - champ PERSO (colonne `cf_*`, qui n'appartient qu'à lui) : la ligne
//     partait mais la colonne et ses valeurs restaient en base indéfiniment.
//     Ici la colonne est droppée — les valeurs sont détruites, après une
//     sauvegarde JSON dans `uploads/backups/`, seul filet possible puisque la
//     corbeille n'a plus rien à restaurer.
//
// Un champ virtuel (formule, lookup, rollup, lien, auto) n'a pas de colonne
// physique : il ne reste que la suppression de la ligne et la régénération de
// la vue.
import fs from 'fs'
import path from 'path'
import db from '../db/database.js'
import { regenerateView } from './customFieldsView.js'
import { invalidateColumnsCache } from '../db/changeLog.js'
import { uploadsPath } from '../config/uploads.js'

const CF_PREFIX = /^cf_/
// LIKE 'cf\_%' ESCAPE '\' — sans l'échappement, `_` est un joker et la clause
// attraperait n'importe quelle colonne de 3 lettres commençant par « cf ».
const NOT_CF_SQL = String.raw`p.column_name NOT LIKE 'cf\_%' ESCAPE '\'`

// Colonnes physiques de la table (une colonne de champ virtuel n'existe que
// dans la vue <table>_v, jamais ici).
function physicalColumns(erpTable) {
  try { return new Set(db.pragma(`table_info(${erpTable})`).map(c => c.name)) }
  catch { return new Set() }
}

// Sauvegarde des valeurs qu'on s'apprête à détruire. Best effort : un échec
// d'écriture ne doit pas empêcher la purge (un disque plein ne rend pas la
// corbeille inutilisable), mais il est journalisé.
function backupValues(erpTable, columns) {
  try {
    const dir = uploadsPath('backups')
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)
    const file = path.join(dir, `champs-purges-${erpTable}-${stamp}.json`)
    const rows = db.prepare(
      `SELECT id, ${columns.map(c => `[${c}]`).join(', ')} FROM ${erpTable}`
    ).all()
    fs.writeFileSync(file, JSON.stringify({ table: erpTable, columns, purged_at: new Date().toISOString(), rows }, null, 1))
    return file
  } catch (e) {
    console.warn(`[purge champs] sauvegarde ${erpTable} impossible :`, e.message)
    return null
  }
}

// Clés de vue rangées sous un autre nom que la table SQL : la page /retours
// (`retours`) et les tableaux encastrés dans une fiche ont leurs propres vues.
// Miroir de VIEW_KEY_TO_SQL_TABLE (routes/views.js), étendu aux encastrés.
const VIEW_KEYS_OF_TABLE = {
  returns: ['retours', 'company_retours'],
  return_items: ['retour_items'],
  order_items: ['shipment_items'],
  shipments: ['order_envois', 'adresse_envois', 'company_envois'],
  serial_numbers: ['company_serials'],
  stock_movements: ['product_movements'],
  contacts: ['company_contacts'],
  projects: ['company_projects'],
  orders: ['company_orders'],
  factures: ['company_factures', 'project_factures'],
  tickets: ['company_tickets'],
  purchases: ['company_achats', 'product_purchases'],
  subscriptions: ['abonnements', 'company_abonnements'],
}
export const viewKeysOf = erpTable => [erpTable, ...(VIEW_KEYS_OF_TABLE[erpTable] || [])]

// Nettoie toutes les traces de configuration d'un champ détruit : vues
// enregistrées (pastilles et vue « Tous »), disposition des fiches, formulaires
// d'ajout, colonnes gelées du sync Airtable. Une colonne citée là après la purge
// est une colonne fantôme — invisible dans les réglages, mais toujours lue.
export function cleanPurgedReferences(erpTable, columns) {
  const dropped = columns instanceof Set ? columns : new Set(columns)
  const out = { pills: 0, pills_removed: 0, configs: 0, details: 0, forms: 0, frozen: 0 }
  if (!dropped.size) return out
  const parse = (raw, fallback) => { try { return JSON.parse(raw) ?? fallback } catch { return fallback } }
  const keyOf = x => (typeof x === 'string' ? x : (x?.field || x?.id || x?.key || x?.column))
  // Les filtres récents sont des groupes AND/OR imbriqués, les anciens
  // sont des tableaux. Retirer aussi les groupes devenus vides.
  const cleanFilters = node => {
    if (Array.isArray(node)) return node.map(cleanFilters).filter(n => n != null)
    if (!node || typeof node !== 'object') return node
    if (!Array.isArray(node.rules) && dropped.has(keyOf(node))) return null
    if (Array.isArray(node.rules)) {
      const rules = cleanFilters(node.rules)
      return rules.length ? { ...node, rules } : null
    }
    return node
  }
  const cleanValue = (raw, shape) => {
    if (raw == null || raw === '') return undefined
    if (shape === 'filters') {
      const v = parse(raw, null)
      if (v == null) return undefined
      const next = cleanFilters(v) ?? []
      return JSON.stringify(v) === JSON.stringify(next) ? undefined : JSON.stringify(next)
    }
    if (shape === 'map') {
      const v = parse(raw, null)
      if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
      if (!Object.keys(v).some(k => dropped.has(k))) return undefined
      return JSON.stringify(Object.fromEntries(Object.entries(v).filter(([k]) => !dropped.has(k))))
    }
    // list, ou scalaire legacy (group_by « category »)
    const v = parse(raw, raw)
    if (Array.isArray(v)) {
      if (!v.some(x => dropped.has(keyOf(x)))) return undefined
      return JSON.stringify(v.filter(x => !dropped.has(keyOf(x))))
    }
    if (typeof v === 'string' && dropped.has(v)) return null
    return undefined
  }
  const patchRow = (table, keyCol, row, shapes) => {
    const patch = {}
    for (const [col, shape] of Object.entries(shapes)) {
      if (!(col in row)) continue
      const next = cleanValue(row[col], shape)
      if (next !== undefined) patch[col] = next
    }
    if (!Object.keys(patch).length) return false
    const sets = Object.keys(patch).map(k => `${k}=?`).join(', ')
    db.prepare(`UPDATE ${table} SET ${sets} WHERE ${keyCol}=?`).run(...Object.values(patch), row[keyCol])
    return true
  }
  const rowsOf = (sql, ...args) => { try { return db.prepare(sql).all(...args) } catch { return [] } }

  for (const key of viewKeysOf(erpTable)) {
    for (const p of rowsOf('SELECT * FROM table_view_pills WHERE table_name=?', key)) {
      // Pastille dont TOUT le filtre reposait sur un champ détruit : vidée, elle
      // afficherait tout sous une étiquette fausse — supprimée.
      const f = parse(p.filters, [])
      const rules = Array.isArray(f) ? f : (Array.isArray(f?.rules) ? f.rules : [])
      if (rules.length && rules.every(r => !Array.isArray(r?.rules) && dropped.has(keyOf(r)))) {
        db.prepare('DELETE FROM table_view_pills WHERE id=?').run(p.id)
        out.pills_removed++
        continue
      }
      if (patchRow('table_view_pills', 'id', p, {
        visible_columns: 'list', sort: 'list', filters: 'filters', color_rules: 'list',
        group_by: 'list', column_widths: 'map',
      })) out.pills++
    }
    for (const c of rowsOf('SELECT * FROM table_view_configs WHERE table_name=?', key)) {
      if (patchRow('table_view_configs', 'id', c, {
        visible_columns: 'list', default_sort: 'list', column_widths: 'map', footer_aggregations: 'map',
      })) out.configs++
    }
    for (const d of rowsOf('SELECT * FROM detail_field_configs WHERE entity_type=?', key)) {
      if (patchRow('detail_field_configs', 'id', d, { field_order: 'list' })) out.details++
    }
    for (const f of rowsOf('SELECT * FROM table_form_configs WHERE table_name=?', key)) {
      if (patchRow('table_form_configs', 'table_name', f, { fields: 'list' })) out.forms++
    }
  }
  try {
    const del = db.prepare('DELETE FROM airtable_frozen_columns WHERE erp_table=? AND column_name=?')
    for (const c of dropped) out.frozen += del.run(erpTable, c).changes
  } catch { /* table absente */ }
  return out
}

// Le mapping Airtable N'EST PAS supprimé, il est coupé : c'est cette ligne, en
// import_disabled=1, qui marque le champ « désactivé » dans la modale de sync.
// Sans elle, le champ Airtable se réaffiche comme disponible à l'import — il a
// l'air d'être revenu, et un clic suffit à recréer colonne + champ. La couper
// est aussi indispensable après un DROP COLUMN : un import visant une colonne
// disparue échouerait à chaque passage.
function disableAirtableMappings(erpTable, columns) {
  if (!columns.length) return 0
  const ph = columns.map(() => '?').join(',')
  try {
    return db.prepare(`
      UPDATE airtable_field_mappings
      SET import_disabled=1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE erp_table=? AND column_name IN (${ph}) AND import_disabled IS NOT 1
    `).run(erpTable, ...columns).changes
  } catch { return 0 }
}

/**
 * Détruit définitivement les champs dont les ids `custom_fields` sont donnés.
 *
 * Retourne `{ purged, blocked, dropped, tombstones, backups }` — `blocked` a la
 * même forme que dans la corbeille (une clé étrangère qui retient une ligne ne
 * doit pas emporter tout le lot).
 */
export function purgeFields(ids) {
  const out = { purged: 0, blocked: [], dropped: [], tombstones: 0, backups: [] }
  if (!ids?.length) return out

  const ph = ids.map(() => '?').join(',')
  const rows = db.prepare(
    `SELECT id, erp_table, column_name, name, kind FROM custom_fields WHERE id IN (${ph})`
  ).all(...ids)
  if (!rows.length) return out

  // Colonnes à dropper, par table : champ perso (cf_*) dont la colonne existe
  // physiquement. Tout le reste garde sa colonne.
  const dropByTable = new Map()
  for (const r of rows) {
    if (!CF_PREFIX.test(r.column_name)) continue
    if (!physicalColumns(r.erp_table).has(r.column_name)) continue
    if (!dropByTable.has(r.erp_table)) dropByTable.set(r.erp_table, [])
    dropByTable.get(r.erp_table).push(r.column_name)
  }

  // Sauvegarde HORS transaction : écrire un fichier n'est pas annulable, et on
  // veut le filet même si la purge échoue ensuite.
  for (const [table, columns] of dropByTable) {
    const file = backupValues(table, columns)
    if (file) out.backups.push(file)
  }

  const insertTombstone = db.prepare(`
    INSERT INTO purged_fields (erp_table, column_name, label, dropped)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(erp_table, column_name) DO UPDATE
      SET label = COALESCE(NULLIF(excluded.label, ''), purged_fields.label),
          dropped = MAX(purged_fields.dropped, excluded.dropped),
          purged_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `)
  const deleteRow = db.prepare(`DELETE FROM custom_fields WHERE id=?`)

  db.transaction(() => {
    const purgedRows = []
    for (const r of rows) {
      try {
        if (deleteRow.run(r.id).changes) { out.purged++; purgedRows.push(r) }
      } catch (e) {
        out.blocked.push({ id: r.id, error: e.message })
      }
    }

    // Pierre tombale permanente — posée pour tous, lue seulement pour les
    // colonnes non `cf_` (les seules dont une définition peut revenir).
    for (const r of purgedRows) {
      const willDrop = dropByTable.get(r.erp_table)?.includes(r.column_name) ? 1 : 0
      insertTombstone.run(r.erp_table, r.column_name, r.name || r.column_name, willDrop)
      out.tombstones++
    }

    const purgedCols = new Set(purgedRows.map(r => `${r.erp_table} ${r.column_name}`))
    for (const [table, columns] of dropByTable) {
      // On ne droppe que les colonnes dont la ligne est bien partie.
      const cols = columns.filter(c => purgedCols.has(`${table} ${c}`))
      if (!cols.length) continue
      // La vue <table>_v référence la colonne (ne serait-ce que par SELECT *) :
      // SQLite refuse le DROP COLUMN tant qu'elle existe. On la régénère juste
      // après, à partir des champs virtuels restants.
      db.exec(`DROP VIEW IF EXISTS ${table}_v`)
      for (const c of cols) {
        db.exec(`ALTER TABLE ${table} DROP COLUMN [${c}]`)
        out.dropped.push(`${table}.${c}`)
      }
      regenerateView(table)
      disableAirtableMappings(table, cols)
    }

    // Toutes les colonnes purgées, droppées ou non : un champ natif détruit ne
    // doit pas non plus rester cité dans les vues et les fiches.
    const purgedByTable = new Map()
    for (const r of purgedRows) {
      if (!purgedByTable.has(r.erp_table)) purgedByTable.set(r.erp_table, new Set())
      purgedByTable.get(r.erp_table).add(r.column_name)
    }
    for (const [table, cols] of purgedByTable) cleanPurgedReferences(table, cols)
  })()

  // Les pierres tombales retirent ces colonnes du snapshot client, même quand
  // aucune colonne physique n'a été droppée (champ natif) — donc pas de
  // regenerateView pour le faire à notre place.
  if (out.purged) invalidateColumnsCache()

  if (out.dropped.length) {
    console.log(`🧹 purge champs : ${out.dropped.length} colonne(s) détruite(s) — ${out.dropped.join(', ')}`)
  }
  return out
}

// Une re-création explicite du champ efface la pierre tombale (« remettre » un
// champ natif, adoption d'une colonne).
export function clearFieldTombstone(erpTable, columnName) {
  try {
    return db.prepare(`DELETE FROM purged_fields WHERE erp_table=? AND column_name=?`)
      .run(erpTable, columnName).changes
  } catch { return 0 }
}

// Champs détruits définitivement d'une table, hors colonnes `cf_*` (rien ne
// peut ressusciter celles-là) et hors colonnes qui portent de nouveau un champ
// vivant (adoption ou personnalisation postérieure à la purge).
export function purgedNativeFields(erpTable) {
  try {
    return db.prepare(`
      SELECT p.column_name, p.label
      FROM purged_fields p
      WHERE p.erp_table = ?
        AND ${NOT_CF_SQL}
        AND NOT EXISTS (
          SELECT 1 FROM custom_fields cf
          WHERE cf.erp_table = p.erp_table AND cf.column_name = p.column_name
            AND cf.deleted_at IS NULL
        )
    `).all(erpTable)
  } catch { return [] }
}
