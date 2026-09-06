/**
 * 025 — « Raison du refus » (Projets) : le natif meurt, le champ personnalisé reste.
 *
 * La table portait DEUX fois le même champ :
 *   • `projects.refusal_reason` — colonne native, déclarée dans schema.js,
 *     affichée sur la fiche en zone de texte libre ;
 *   • `projects.raison_du_refus` — champ personnalisé (`custom_fields`,
 *     single_select, 15 choix colorés), miroir du champ Airtable
 *     `fldCtdPAmla5sdnnn` « Raison du refus ».
 *
 * Les deux colonnes portaient la MÊME valeur sur les 1 642 projets (689 non
 * vides) : le mapping natif a un `airtable_field_id` synthétique
 * (`native_refusal_reason`) qui n'existe pas dans Airtable, donc `twinDefs()`
 * (services/airtableAutoSync.js) l'acceptait comme jumeau du vrai champ et
 * alimentait les deux à chaque sync. La saisie faite dans l'ERP sur le natif
 * était donc écrasée au sync suivant — l'éditabilité de la colonne native était
 * une illusion. Demande : « convertis-le en champ personnalisé et supprime
 * complètement ce champ natif. Complete wipe. Drop field. » — la conversion est
 * ce champ personnalisé, qui devient la seule « Raison du refus ».
 *
 * Ordre d'opérations (cf. 023-drop-projects-nb-de-serres) :
 *   1. report des valeurs natives que le champ personnalisé n'aurait pas ;
 *   2. DROP VIEW projects_v — SQLite refuse le DROP COLUMN tant qu'une vue
 *      référence la table ;
 *   3. ALTER TABLE projects DROP COLUMN refusal_reason ;
 *   4. suppression des lignes de registre qui décrivaient le NATIF :
 *      `airtable_field_mappings` (id synthétique `native_refusal_reason` — ce
 *      n'est pas un vrai champ Airtable, donc pas de pierre tombale à garder,
 *      contrairement aux mappings de champs réels) et `airtable_field_defs` ;
 *   5. `airtable_field_map` (registre du miroir) repointé sur la colonne
 *      survivante : le champ Airtable reste « mirrored », il l'est simplement
 *      vers `raison_du_refus`. Le supprimer l'aurait renvoyé dans les champs
 *      « sans décision » du miroir ;
 *   6. nettoyage des vues enregistrées (colonne fantôme dans la barre des vues) ;
 *   7. disposition de la fiche : le natif tenait sa place entre « Vendeur AT »
 *      et « Notes ». Une colonne de sync arrive `defaultHidden` (elle attend
 *      dans « Ajouter un champ »), donc sans cette ligne le champ aurait
 *      DISPARU de la fiche projet ;
 *   8. regenerateView('projects') — la vue porte les champs calculés, la
 *      recréer à la main la casserait.
 *
 * Défensive : chaque garde-fou renvoie `skipped` au lieu de lever — une
 * exception arrêterait le démarrage du serveur.
 */
import { v4 as uuidv4 } from 'uuid'
import db from '../database.js'
import { regenerateView } from '../../services/customFieldsView.js'

export const id = '025-drop-projects-refusal-reason'
export const description = 'projects.refusal_reason droppée — « Raison du refus » ne vit plus que comme champ personnalisé'

const TABLE = 'projects'
const COLUMN = 'refusal_reason'
const KEEP = 'raison_du_refus'

// Ordre des champs de la fiche projet (pages/ProjectDetail.jsx), avec le champ
// personnalisé à la place exacte qu'occupait le natif.
const DETAIL_ORDER = [
  'name', 'company_name', 'type', 'probability', 'close_date', 'orders',
  'vendeur_label', 'nom_du_vendeur', KEEP, 'notes',
]

export function up(migrationDb) {
  const d = migrationDb || db

  const cols = new Set(d.pragma(`table_info(${TABLE})`).map(c => c.name))
  if (!cols.has(COLUMN)) return { skipped: 'colonne déjà absente' }
  if (!cols.has(KEEP)) return { skipped: `colonne ${KEEP} absente — rien pour recueillir les valeurs` }

  // Le champ personnalisé qui reprend le flambeau doit être vivant : détruire le
  // natif alors qu'il est la dernière copie effacerait 689 valeurs.
  const keeper = d.prepare(
    `SELECT id, name, type, options FROM custom_fields
      WHERE erp_table=? AND column_name=? AND deleted_at IS NULL`
  ).get(TABLE, KEEP)
  if (!keeper) return { skipped: `champ personnalisé « ${KEEP} » absent ou à la corbeille` }

  // Les deux colonnes se contredisent-elles quelque part ? Ce serait une
  // décision humaine (laquelle garde-t-on ?), pas une conversion automatique.
  const { n: divergent } = d.prepare(
    `SELECT COUNT(*) AS n FROM ${TABLE}
      WHERE TRIM(COALESCE([${COLUMN}],'')) != ''
        AND TRIM(COALESCE([${KEEP}],'')) != ''
        AND TRIM([${COLUMN}]) != TRIM([${KEEP}])`
  ).get()
  if (divergent) return { skipped: `${divergent} projet(s) où les deux champs divergent — arbitrage manuel requis` }

  // Report des valeurs que seul le natif porte. `raison_du_refus` est une liste
  // de choix : une valeur hors liste s'afficherait comme un choix inconnu, on
  // préfère s'arrêter et laisser l'utilisateur ajouter le choix.
  const orphans = d.prepare(
    `SELECT id, [${COLUMN}] AS v FROM ${TABLE}
      WHERE TRIM(COALESCE([${COLUMN}],'')) != '' AND TRIM(COALESCE([${KEEP}],'')) = ''`
  ).all()
  if (orphans.length) {
    const labels = new Set(choiceLabels(keeper.options))
    const unknown = [...new Set(orphans.map(r => r.v.trim()).filter(v => !labels.has(v)))]
    if (unknown.length) {
      return { skipped: `valeur(s) hors des choix de « ${keeper.name} » : ${unknown.slice(0, 5).join(', ')}` }
    }
    const carry = d.prepare(`UPDATE ${TABLE} SET [${KEEP}] = TRIM([${COLUMN}]) WHERE id = ?`)
    for (const row of orphans) carry.run(row.id)
  }

  d.exec(`DROP VIEW IF EXISTS ${TABLE}_v`)
  d.exec(`ALTER TABLE ${TABLE} DROP COLUMN [${COLUMN}]`)

  d.prepare(`DELETE FROM custom_fields WHERE erp_table=? AND column_name=?`).run(TABLE, COLUMN)
  d.prepare(`DELETE FROM airtable_field_mappings WHERE erp_table=? AND column_name=?`).run(TABLE, COLUMN)
  try {
    d.prepare(`DELETE FROM airtable_field_defs WHERE erp_table=? AND column_name=?`).run(TABLE, COLUMN)
  } catch { /* table héritée absente */ }

  // Registre du miroir : le champ Airtable est toujours mis en miroir, mais vers
  // la colonne survivante. Ne rien faire si une ligne pointe déjà sur elle.
  let remapped = 0
  const already = d.prepare(
    `SELECT id FROM airtable_field_map WHERE mirror_id='projets' AND erp_column=?`
  ).get(KEEP)
  if (!already) {
    remapped = d.prepare(
      `UPDATE airtable_field_map SET erp_column=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE mirror_id='projets' AND erp_column=?`
    ).run(KEEP, COLUMN).changes
  } else {
    d.prepare(`DELETE FROM airtable_field_map WHERE mirror_id='projets' AND erp_column=?`).run(COLUMN)
  }

  const cleaned = cleanSavedViews(d)
  const layout = keepFieldOnDetailCard(d)
  regenerateView(TABLE)

  return {
    dropped: `${TABLE}.${COLUMN}`, carried_over: orphans.length,
    views_cleaned: cleaned, mirror_remapped: remapped, detail_layout: layout,
  }
}

function choiceLabels(rawOptions) {
  try {
    const parsed = JSON.parse(rawOptions || '{}')
    return (parsed.choices || []).map(c => c.label).filter(Boolean)
  } catch { return [] }
}

// La fiche projet déclarait « Raison du refus » en dur ; le champ personnalisé
// qui le remplace est une colonne de sync, donc repliée d'office. On écrit la
// disposition partagée (detail_field_configs, cf. lib/detailFieldLayout.jsx)
// pour qu'il garde sa place. Ne touche à rien si une disposition existe déjà :
// elle vient alors d'un choix de l'utilisateur.
function keepFieldOnDetailCard(d) {
  const existing = d.prepare(
    `SELECT id, field_order FROM detail_field_configs WHERE entity_type=?`
  ).get(TABLE)
  if (existing) {
    let order
    try { order = JSON.parse(existing.field_order) } catch { return 'illisible, laissée telle quelle' }
    if (!Array.isArray(order)) return 'forme inattendue, laissée telle quelle'
    const keyOf = (e) => (typeof e === 'string' ? e : e?.key)
    if (order.some(e => keyOf(e) === KEEP)) return 'déjà présent'
    const at = order.findIndex(e => keyOf(e) === COLUMN)
    const entry = { key: KEEP, hidden: false }
    if (at >= 0) order.splice(at, 1, entry)
    else order.push(entry)
    d.prepare(`UPDATE detail_field_configs SET field_order=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
      .run(JSON.stringify(order), existing.id)
    return at >= 0 ? 'remplacé sur place' : 'ajouté en fin de disposition'
  }
  d.prepare(`INSERT INTO detail_field_configs (id, entity_type, field_order) VALUES (?,?,?)`)
    .run(uuidv4(), TABLE, JSON.stringify(DETAIL_ORDER.map(key => ({ key, hidden: false }))))
  return 'disposition créée'
}

// Vues enregistrées : une colonne droppée qui traîne dans visible_columns /
// sort / filters / color_rules / group_by / column_widths laisse une colonne
// fantôme dans la barre des vues.
function cleanSavedViews(d) {
  const parse = (raw, fallback) => {
    try { return JSON.parse(raw || fallback) } catch { return JSON.parse(fallback) }
  }
  const keyOf = (x) => (typeof x === 'string' ? x : (x?.field ?? x?.id))
  const without = (arr) => arr.filter(x => keyOf(x) !== COLUMN)
  const withoutKey = (obj) => Object.fromEntries(Object.entries(obj).filter(([k]) => k !== COLUMN))
  let cleaned = 0

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
        patch[col] = JSON.stringify(
          Array.isArray(raw) ? without(raw) : { ...raw, rules: without(list) }
        )
      } else if (kind === 'map') {
        const map = parse(row[col], '{}')
        if (Object.hasOwn(map, COLUMN)) patch[col] = JSON.stringify(withoutKey(map))
      } else if (kind === 'scalar' && row[col] === COLUMN) {
        patch[col] = null
      }
    }
    if (!Object.keys(patch).length) return
    const sets = Object.keys(patch).map(k => `${k}=?`).join(', ')
    d.prepare(`UPDATE ${table} SET ${sets} WHERE id=?`).run(...Object.values(patch), row.id)
    cleaned++
  }

  for (const row of d.prepare(`SELECT * FROM table_view_pills WHERE table_name=?`).all(TABLE)) {
    patchRow('table_view_pills', row, {
      visible_columns: 'list', sort: 'list', filters: 'list', color_rules: 'list',
      column_widths: 'map', group_by: 'scalar',
    })
  }
  try {
    for (const row of d.prepare(`SELECT * FROM table_view_configs WHERE table_name=?`).all(TABLE)) {
      patchRow('table_view_configs', row, {
        visible_columns: 'list', default_sort: 'list',
        column_widths: 'map', footer_aggregations: 'map',
      })
    }
  } catch { /* table absente */ }

  return cleaned
}
