/**
 * 023 — « Nb de serres » (Projets) : suppression DÉFINITIVE.
 *
 * Le champ était déjà à la corbeille (ligne `custom_fields` en `deleted_at`,
 * mapping Airtable en `import_disabled=1`), mais un champ à la corbeille garde
 * sa colonne SQLite : invisible, jamais lue, jamais nettoyée — et la ligne
 * traînait dans la corbeille des champs. Demande explicite : « drop field, plus
 * aucune trace nulle part ».
 *
 * Même ordre d'opérations que les scripts drop-<table>-airtable-only-cols.js
 * (cf. services/fieldPurge.js) :
 *   1. DROP VIEW projects_v — SQLite refuse le DROP COLUMN tant qu'une vue
 *      référence la table, ne serait-ce que par SELECT * ;
 *   2. ALTER TABLE projects DROP COLUMN nb_de_serres ;
 *   3. DELETE custom_fields + airtable_field_defs ;
 *   4. nettoyage des vues enregistrées (table_view_pills / table_view_configs) :
 *      la colonne traînait dans les colonnes visibles de la vue « Ouvert » ;
 *   5. regenerateView('projects') — la vue porte des champs calculés (lookups,
 *      rollups, formules), la recréer « à la main » la casserait.
 *
 * Ce qui RESTE volontairement : la ligne `airtable_field_mappings` en
 * `import_disabled=1`. Ce n'est pas une trace du champ ERP, c'est la décision
 * « ne pas importer ce champ Airtable » — la supprimer ferait réapparaître
 * « Nb de serres » comme champ Airtable disponible dans la modale de sync et
 * comme champ « sans décision » dans le registre du miroir (dont l'état
 * `excluded` est dérivé de ce drapeau). La colonne étant droppée, elle ne
 * réapparaît nulle part dans /champs/projects : `erp_columns` se dérive du
 * PRAGMA de la table (routes/connectors.js), et une colonne absente n'a plus
 * de ligne.
 *
 * Défensive : chaque garde-fou renvoie `skipped` au lieu de lever — un champ
 * redevenu vivant, une valeur saisie entre-temps ou un champ calculé qui en
 * dépend doit empêcher la destruction, pas empêcher le serveur de démarrer.
 * Aucune sauvegarde JSON : la colonne est vérifiée vide avant le drop.
 */
import db from '../database.js'
import { regenerateView } from '../../services/customFieldsView.js'

export const id = '023-drop-projects-nb-de-serres'
export const description = 'projects.nb_de_serres droppée — champ « Nb de serres » détruit'

const TABLE = 'projects'
const COLUMN = 'nb_de_serres'

export function up(migrationDb) {
  const d = migrationDb || db

  const cols = new Set(d.pragma(`table_info(${TABLE})`).map(c => c.name))
  if (!cols.has(COLUMN)) return { skipped: 'colonne déjà absente' }

  // Le champ a-t-il été restauré depuis la corbeille ? On ne détruit pas un
  // champ que l'utilisateur a remis en service.
  const alive = d.prepare(
    `SELECT name FROM custom_fields
      WHERE erp_table=? AND column_name=? AND deleted_at IS NULL`
  ).get(TABLE, COLUMN)
  if (alive) return { skipped: `champ « ${alive.name} » redevenu actif` }

  // L'import Airtable a-t-il été réactivé ?
  const imported = d.prepare(
    `SELECT airtable_field_name FROM airtable_field_mappings
      WHERE erp_table=? AND column_name=? AND import_disabled IS NOT 1`
  ).get(TABLE, COLUMN)
  if (imported) return { skipped: `import Airtable actif (${imported.airtable_field_name})` }

  // Un lookup / rollup d'une autre table qui viserait la colonne serait vidé
  // en silence.
  const dependent = d.prepare(
    `SELECT erp_table, name, kind FROM custom_fields
      WHERE deleted_at IS NULL
        AND ((lookup_target_table=? AND lookup_target_column=?)
          OR (rollup_target_table=? AND rollup_target_column=?))`
  ).get(TABLE, COLUMN, TABLE, COLUMN)
  if (dependent) return { skipped: `champ calculé dépendant : ${dependent.erp_table}.${dependent.name}` }

  // Valeurs : la colonne est vide (1 642 projets, 0 valeur) — c'est ce qui
  // dispense de la sauvegarde JSON des scripts de purge. Si quelque chose y a
  // été écrit entre-temps, on s'arrête plutôt que de détruire sans filet.
  const { n } = d.prepare(
    `SELECT COUNT(*) AS n FROM ${TABLE}
      WHERE [${COLUMN}] IS NOT NULL AND TRIM(CAST([${COLUMN}] AS TEXT)) != ''`
  ).get()
  if (n) return { skipped: `${n} valeur(s) non vide(s) — purge manuelle requise` }

  d.exec(`DROP VIEW IF EXISTS ${TABLE}_v`)
  d.exec(`ALTER TABLE ${TABLE} DROP COLUMN [${COLUMN}]`)

  d.prepare(`DELETE FROM custom_fields WHERE erp_table=? AND column_name=?`).run(TABLE, COLUMN)
  try {
    d.prepare(`DELETE FROM airtable_field_defs WHERE erp_table=? AND column_name=?`).run(TABLE, COLUMN)
  } catch { /* table héritée absente */ }

  const cleaned = cleanSavedViews(d)
  regenerateView(TABLE)

  return { dropped: `${TABLE}.${COLUMN}`, views_cleaned: cleaned }
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
        // aujourd'hui. Traiter l'objet comme un tableau ferait un TypeError
        // sur `.some`, en pleine transaction de migration.
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
