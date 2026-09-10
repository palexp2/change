/**
 * 048 — `tickets.assigned_to` : suppression DÉFINITIVE.
 *
 * Signalement utilisateur depuis /champs/tickets : « pourquoi y a-t-il deux
 * champs "Assigné à" dans le formulaire et dans la fiche d'un billet, mais un
 * seul dans la page de configuration des champs ? Ne conserver que celui de la
 * page de configuration et supprimer l'autre définitivement. »
 *
 * ── Les deux « Assigné à » ────────────────────────────────────────────────
 *  1. `tickets.assigned_name` — le SURVIVANT, et le seul que /champs/tickets
 *     montre : vraie colonne, champ perso `kind='data'` (texte) alimenté par le
 *     champ Airtable « Responsable » (`airtable_field_mappings`, import actif).
 *     3 686 valeurs sur 3 688 billets (« Phil », « Fred », « PA »…).
 *  2. `tickets.assigned_to` — le DOUBLON : une FK vers `users`, codée en dur
 *     dans la fiche (`TicketDetail.jsx`) et dans le formulaire « Nouveau
 *     billet » (`Tickets.jsx`), donc invisible de /champs/tickets, qui ne
 *     connaît que les champs perso et `TABLE_COLUMN_META`. 8 valeurs sur 3 688.
 *     C'est le dernier reste de l'époque où un billet vivait dans l'ERP : le
 *     support assigne dans Airtable depuis longtemps.
 *
 * ── Conséquences assumées ─────────────────────────────────────────────────
 *  • la notification « Billet assigné » disparaît (elle visait un utilisateur
 *    ERP par son id ; « Assigné à » ne porte plus qu'un prénom texte, aucune
 *    cible notifiable) ;
 *  • le filtre `GET /api/tickets?assigned_to=` disparaît (aucun appelant) ;
 *  • le champ survivant est en LECTURE SEULE tant que son sens de sync reste
 *    « import » — réglable d'un clic dans /champs/tickets.
 *
 * Même voie que 023 / 028 / 029 / 030 / 032 / 033 / 035 / 037 / 040 / 041 /
 * 045 / 046 (migration numérotée, tracée dans `schema_migrations`, appliquée au
 * `pm2 restart`).
 *
 * ── Ce qu'il a fallu couper côté code (hors migration) ────────────────────
 *  • `routes/tickets.js` — filtre `?assigned_to=`, colonne du INSERT, clé
 *    modifiable du PUT, et les deux appels `notifyAssignment` ;
 *  • `services/nativeFieldConversions.js` — l'entrée `tickets.assigned_name`
 *    déclarait un LOOKUP sur `assigned_to` (état d'avant sa conversion en
 *    colonne réelle) : la garder ferait construire `tickets_v` sur une FK
 *    disparue au prochain semis d'une base neuve ;
 *  • `db/schema.js` — la colonne sort du CREATE TABLE (initSchema tourne AVANT
 *    les migrations : une base neuve la recréerait, piège de la 026) ;
 *  • côté client `Tickets.jsx` (champ du formulaire + recopie du nom depuis la
 *    liste des utilisateurs) et `TicketDetail.jsx` (champ « Assigne a »).
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

export const id = '048-drop-tickets-assigned-to'
export const description =
  'tickets.assigned_to droppée — un billet n\'a plus qu\'un « Assigné à », celui de /champs/tickets'

const TABLE = 'tickets'
const COLUMN = 'assigned_to'
// Le champ qui reste sous le libellé « Assigné à » : c'est lui qui doit prendre
// la place du doublon sur la fiche.
const SURVIVOR = 'assigned_name'
const MIRROR = 'billets'
// Les vues sauvegardées sont rangées sous le nom de la RESSOURCE (cf. DataTable
// table=…) ; ici les deux coïncident, on garde la forme des migrations sœurs.
const VIEW_TABLES = ['tickets']

export function up(migrationDb) {
  const d = migrationDb || db

  const cols = new Set(d.pragma(`table_info(${TABLE})`).map(c => c.name))
  if (!cols.has(COLUMN)) return { skipped: 'colonne déjà absente' }
  // On ne détruit un doublon que si l'original tient (garde-fou de la 033).
  if (!cols.has(SURVIVOR)) return { skipped: `colonne survivante ${SURVIVOR} absente` }

  // Un lookup / rollup qui viserait la colonne serait vidé en silence — y
  // compris celui de CETTE table (`assigned_name` l'a été jusqu'à sa conversion
  // en colonne réelle : `lookup_fk = assigned_to`).
  const dependent = d.prepare(
    `SELECT erp_table, name FROM custom_fields
      WHERE deleted_at IS NULL
        AND ((lookup_target_table=? AND lookup_target_column=?)
          OR (rollup_target_table=? AND rollup_target_column=?)
          OR (erp_table=? AND kind='lookup' AND lookup_fk=?))`
  ).get(TABLE, COLUMN, TABLE, COLUMN, TABLE, COLUMN)
  if (dependent) return { skipped: `champ calculé dépendant : ${dependent.erp_table}.${dependent.name}` }

  // Une formule de cette table qui nomme la colonne tomberait en erreur de vue.
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

  // SQLite refuse DROP COLUMN sur une colonne indexée : l'index de FK posé par
  // la 001 part avec elle (une FK détruite n'a plus rien à accélérer).
  let indexesDropped = 0
  for (const ix of d.pragma(`index_list(${TABLE})`)) {
    if (ix.origin !== 'c') continue // index implicite (PK / UNIQUE) : pas droppable
    if (!d.pragma(`index_info(${ix.name})`).some(c => c.name === COLUMN)) continue
    d.exec(`DROP INDEX IF EXISTS ${ix.name}`)
    indexesDropped++
  }

  d.exec(`DROP VIEW IF EXISTS ${TABLE}_v`)
  d.exec(`ALTER TABLE ${TABLE} DROP COLUMN [${COLUMN}]`)

  // Aucune ligne attendue (la colonne n'a jamais eu de champ perso ni de
  // mapping) : nettoyage défensif, au cas où l'une aurait été semée depuis.
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
  const layout = fixDetailLayout(d)

  regenerateView(TABLE)

  return {
    dropped: `${TABLE}.${COLUMN}`, backup, indexes_dropped: indexesDropped,
    custom_fields_removed: fields, airtable_mappings_removed: mappings,
    airtable_defs_removed: defs, field_map_keys_removed: unmapped,
    mirror_rows_released: released, ...views, ...layout,
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
      `SELECT id, [${COLUMN}] FROM ${TABLE} WHERE [${COLUMN}] IS NOT NULL AND [${COLUMN}] != ''`
    ).all()
    fs.writeFileSync(file, JSON.stringify(
      { table: TABLE, columns: [COLUMN], purged_at: new Date().toISOString(), rows }, null, 1))
    return file
  } catch (e) {
    console.warn(`[048] sauvegarde ${TABLE} impossible :`, e.message)
    return null
  }
}

// Le field_map « cœur » du module billets est vide depuis la 040 et n'a jamais
// porté `assigned_to` (colonne propre à l'ERP) — nettoyage défensif.
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

// Registre du miroir : aucune ligne ne pointe sur `assigned_to` (« Responsable »
// vise `assigned_name`), mais une éventuelle ligne `core` repasserait en
// `unmapped`. Le scope est `erp_column`/`core_key` = la colonne DÉTRUITE seule :
// un filtre plus large attraperait la ligne de la survivante (piège de la 030).
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

// La fiche billet range ses champs dans `detail_field_configs` : le doublon en
// sort, et le survivant prend SA place — il y était marqué masqué (un champ
// perso venu d'une sync arrive replié), il aurait disparu de la fiche.
function fixDetailLayout(d) {
  try {
    const row = d.prepare('SELECT id, field_order FROM detail_field_configs WHERE entity_type=?').get(TABLE)
    if (!row?.field_order) return { detail_layout: 'aucune disposition enregistrée' }
    let list
    try { list = JSON.parse(row.field_order) } catch { return { detail_layout: 'illisible' } }
    if (!Array.isArray(list)) return { detail_layout: 'illisible' }

    const keyOf = (f) => (typeof f === 'string' ? f : f?.key)
    const at = list.findIndex(f => keyOf(f) === COLUMN)
    if (at === -1) return { detail_layout: 'doublon déjà absent' }

    const kept = list.filter(f => keyOf(f) !== COLUMN && keyOf(f) !== SURVIVOR)
    // Le survivant reprend la position exacte du doublon, visible.
    kept.splice(Math.min(at, kept.length), 0, { key: SURVIVOR, hidden: false })
    d.prepare('UPDATE detail_field_configs SET field_order=? WHERE id=?')
      .run(JSON.stringify(kept), row.id)
    return { detail_layout: `${SURVIVOR} affiché en position ${at}` }
  } catch {
    return { detail_layout: 'table absente' }
  }
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
