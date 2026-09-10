/**
 * 039 — Employés : les 28 champs codés en dur deviennent des champs personnalisés.
 *
 * Demande : « convertis tous les champs de cette table en champs personnalisés »
 * (/champs/employees). La conversion elle-même est déclarative et idempotente —
 * elle vit dans services/nativeFieldConversions.js, qui sème une ligne
 * `custom_fields` (kind='data') par colonne à chaque démarrage. Aucun ALTER : les
 * colonnes SQL existent toutes et portent la donnée.
 *
 * Restent deux choses que le semis ne peut pas faire, et qu'on ne veut faire
 * qu'UNE fois :
 *
 * 1. L'id de la colonne « Nom ». Le tableau des employés affichait une colonne
 *    composite `full_name` (pastille d'initiales + « Prénom Nom ») posée sur la
 *    colonne SQL `last_name`. Le champ personnalisé, lui, s'appelle forcément
 *    `last_name` — le nom de sa colonne. Les deux auraient coexisté : deux
 *    colonnes « Nom » dans le tableau, deux lignes dans /champs/employees. La
 *    colonne d'affichage prend donc l'id `last_name` (tableDefs.js), et les vues
 *    enregistrées qui nommaient `full_name` sont RENOMMÉES ici — les vider
 *    amputerait la vue « Actifs » de sa colonne principale.
 *
 * 2. Les colonnes visibles par défaut. Sans réglage enregistré, la vue « Toutes »
 *    affiche toute colonne qui ne se déclare pas `defaultVisible: false` — une
 *    propriété de tableDefs.js, qui disparaît avec les définitions en dur. Le
 *    tableau serait passé de 6 à 29 colonnes du jour au lendemain. On inscrit
 *    donc les 6 colonnes historiques comme réglage par défaut de la table : la
 *    page ne bouge pas, et les 23 autres restent à portée dans le sélecteur de
 *    champs.
 *
 * Défensive : chaque étape vérifie l'état avant d'écrire, et la migration ne
 * touche à `table_view_configs` que si personne n'a déjà choisi ses colonnes.
 */
import db from '../database.js'
import { newRecordId } from '../../utils/recordId.js'

export const id = '039-employees-fields-to-custom'
export const description = 'Employés : colonne « Nom » renommée full_name → last_name dans les vues, colonnes par défaut figées'

const TABLE = 'employees'
const OLD = 'full_name'
const NEW = 'last_name'

// Colonnes affichées d'office avant la conversion (tableDefs.js, entrées sans
// `defaultVisible: false`), dans leur ordre d'origine.
const DEFAULT_COLUMNS = [
  NEW, 'active', 'accounting_department', 'email_work', 'phone_work', 'hire_date',
]

export function up(migrationDb) {
  const d = migrationDb || db
  return {
    views_renamed: renameInSavedViews(d),
    default_columns: pinDefaultColumns(d),
  }
}

// Les vues enregistrées référencent la colonne par son id : `visible_columns`,
// `sort`, `filters`, `color_rules`, `group_by` et `column_widths`. Repris tel
// quel de la migration 026 (même problème, même forme).
function renameInSavedViews(d) {
  const parse = (raw, fallback) => {
    try { return JSON.parse(raw ?? fallback) } catch { return JSON.parse(fallback) }
  }
  const rename = (x) => {
    if (typeof x === 'string') return x === OLD ? NEW : x
    if (x && typeof x === 'object') {
      if (x.field === OLD) return { ...x, field: NEW }
      if (x.id === OLD) return { ...x, id: NEW }
    }
    return x
  }
  const hits = (x) => (typeof x === 'string' ? x === OLD : (x?.field === OLD || x?.id === OLD))
  let renamed = 0

  const patchRow = (table, row, fields) => {
    const patch = {}
    for (const [col, kind] of Object.entries(fields)) {
      if (kind === 'list') {
        // `filters` a deux formes en base : tableau de règles (historique) ou
        // objet `{ conjunction, rules }` (barre de filtres actuelle).
        const raw = parse(row[col], '[]')
        const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.rules) ? raw.rules : [])
        if (!list.some(hits)) continue
        patch[col] = JSON.stringify(
          Array.isArray(raw) ? raw.map(rename) : { ...raw, rules: list.map(rename) }
        )
      } else if (kind === 'map') {
        const map = parse(row[col], '{}')
        if (!Object.hasOwn(map, OLD)) continue
        const { [OLD]: moved, ...rest } = map
        patch[col] = JSON.stringify({ ...rest, [NEW]: moved })
      } else if (kind === 'scalar' && row[col] === OLD) {
        patch[col] = NEW
      }
    }
    if (!Object.keys(patch).length) return
    const sets = Object.keys(patch).map(k => `${k}=?`).join(', ')
    d.prepare(`UPDATE ${table} SET ${sets} WHERE id=?`).run(...Object.values(patch), row.id)
    renamed++
  }

  for (const row of d.prepare('SELECT * FROM table_view_pills WHERE table_name=?').all(TABLE)) {
    patchRow('table_view_pills', row, {
      visible_columns: 'list', sort: 'list', filters: 'list', color_rules: 'list',
      column_widths: 'map', group_by: 'scalar',
    })
  }
  for (const row of d.prepare('SELECT * FROM table_view_configs WHERE table_name=?').all(TABLE)) {
    patchRow('table_view_configs', row, {
      visible_columns: 'list', default_sort: 'list',
      column_widths: 'map', footer_aggregations: 'map',
    })
  }
  return renamed
}

// Réglage par défaut de la table (vue « Toutes »). On n'écrase JAMAIS une liste
// déjà choisie : elle vient de l'utilisateur, elle fait foi.
function pinDefaultColumns(d) {
  const row = d.prepare(
    'SELECT id, visible_columns FROM table_view_configs WHERE table_name=?'
  ).get(TABLE)
  if (!row) {
    d.prepare(
      'INSERT INTO table_view_configs (id, table_name, visible_columns, default_sort) VALUES (?,?,?,?)'
    ).run(newRecordId(), TABLE, JSON.stringify(DEFAULT_COLUMNS), '[]')
    return DEFAULT_COLUMNS.length
  }
  let current = []
  try { current = JSON.parse(row.visible_columns || '[]') } catch { current = [] }
  if (Array.isArray(current) && current.length > 0) return 0
  d.prepare(
    "UPDATE table_view_configs SET visible_columns=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?"
  ).run(JSON.stringify(DEFAULT_COLUMNS), row.id)
  return DEFAULT_COLUMNS.length
}
