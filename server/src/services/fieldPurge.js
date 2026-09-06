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

// Vues enregistrées (barre des vues) : une colonne droppée qui traîne dans
// visible_columns / sort / filters / group_by laisserait une colonne fantôme.
function cleanViewPills(erpTable, dropped) {
  let pills = []
  try { pills = db.prepare(`SELECT * FROM table_view_pills WHERE table_name=?`).all(erpTable) }
  catch { return 0 }
  const list = (raw) => { try { return JSON.parse(raw || '[]') } catch { return [] } }
  let cleaned = 0
  for (const p of pills) {
    const patch = {}
    const vis = list(p.visible_columns)
    if (vis.some(c => dropped.has(c))) patch.visible_columns = JSON.stringify(vis.filter(c => !dropped.has(c)))
    const sort = list(p.sort)
    if (sort.some(s => dropped.has(s?.field || s?.id))) patch.sort = JSON.stringify(sort.filter(s => !dropped.has(s?.field || s?.id)))
    const filters = list(p.filters)
    if (filters.some(f => dropped.has(f?.field || f?.id))) patch.filters = JSON.stringify(filters.filter(f => !dropped.has(f?.field || f?.id)))
    const rules = list(p.color_rules)
    if (rules.some(r => dropped.has(r?.field || r?.id))) patch.color_rules = JSON.stringify(rules.filter(r => !dropped.has(r?.field || r?.id)))
    if (p.group_by && dropped.has(p.group_by)) patch.group_by = null
    let widths = {}
    try { widths = JSON.parse(p.column_widths || '{}') } catch {}
    if (Object.keys(widths).some(c => dropped.has(c))) {
      patch.column_widths = JSON.stringify(Object.fromEntries(Object.entries(widths).filter(([c]) => !dropped.has(c))))
    }
    if (!Object.keys(patch).length) continue
    const sets = Object.keys(patch).map(k => `${k}=?`).join(', ')
    db.prepare(`UPDATE table_view_pills SET ${sets} WHERE id=?`).run(...Object.values(patch), p.id)
    cleaned++
  }
  return cleaned
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
      cleanViewPills(table, new Set(cols))
    }
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
