import db from '../db/database.js'
import { isSafeColumn } from './customFieldsView.js'

// ── Filtre d'un champ lien ───────────────────────────────────────────────────
//
// Un champ de type lien propose, au moment de lier, TOUTES les fiches de sa
// table cible. Ce réglage en restreint la liste : « Produit » ne propose que les
// produits actifs, « Entreprise » que les clients, etc.
//
// Le filtre vit dans les options du champ (`options.link_filter`) sous la forme
// d'une liste de conditions ET-liées :
//
//   [ { column: 'status', op: 'is', value: 'Actif' }, … ]
//
// Il ne touche QUE les candidats proposés : une valeur déjà posée reste
// affichée même si elle ne satisfait plus le filtre (sinon un lien
// disparaîtrait de la fiche sans que rien ne le dise).

// Opérateurs — miroir de LINK_FILTER_OPS côté client
// (client/src/lib/linkFilterOps.js). Tenir les deux listes alignées.
export const LINK_FILTER_OPS = new Set([
  'is', 'is_not', 'is_any_of', 'is_none_of',
  'contains', 'not_contains', 'empty', 'not_empty', 'gt', 'lt',
])

// Opérateurs qui n'attendent pas de valeur.
const VALUE_LESS = new Set(['empty', 'not_empty'])

// Opérateurs dont la valeur est une LISTE de choix (colonne à choix unique).
const MULTI_VALUE = new Set(['is_any_of', 'is_none_of'])

const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/i

// Colonnes d'une table sur lesquelles un filtre peut porter : les colonnes
// physiques (colonnes générées comprises — `table_info` les cache, cf.
// customFieldsView.js), sauf celles au nom sensible.
export function linkFilterColumns(table) {
  if (!SAFE_IDENT.test(table)) return []
  let cols = []
  try { cols = db.pragma(`table_xinfo(${table})`).filter(c => c.hidden !== 1).map(c => c.name) }
  catch { return [] }
  const meta = new Map()
  try {
    for (const r of db.prepare(
      `SELECT column_name, name, type, kind, options FROM custom_fields
       WHERE erp_table=? AND deleted_at IS NULL`
    ).all(table)) meta.set(r.column_name, r)
  } catch { /* pas de champ configuré : le nom technique suffit */ }
  return cols.filter(isSafeColumn).map(c => {
    const m = meta.get(c)
    const out = { column: c, label: m?.name || null }
    // Type + choix d'une colonne à choix : le sélecteur d'opérateur les propose
    // (« est l'un des » plutôt que « contient ») et la valeur se choisit dans la
    // liste au lieu d'être tapée.
    if (m && (m.type === 'single_select' || m.type === 'multi_select')) {
      out.type = m.type
      const choices = selectChoiceValues(m)
      if (choices.length) out.choices = choices
    }
    return out
  })
}

// Valeurs STOCKÉES des choix d'un champ à choix : le label pour un champ perso
// (la colonne cf_* porte le libellé), la `value` pour un natif personnalisé (la
// colonne porte la valeur brute, ex. 'Actif' vs son libellé).
function selectChoiceValues(field) {
  let opts = field.options
  if (typeof opts === 'string') { try { opts = JSON.parse(opts) } catch { return [] } }
  const choices = Array.isArray(opts?.choices) ? opts.choices : []
  return choices
    .map(c => (field.kind === 'native' ? (c?.value ?? c?.label) : (c?.label ?? c?.value)))
    .filter(v => v != null && String(v) !== '')
    .map(v => String(v))
}

// Normalise/valide un filtre pour la table cible indiquée. Lève une Error au
// message clair (colonne inconnue, opérateur inconnu). Retourne un tableau —
// vide = pas de filtre.
export function normalizeLinkFilter(raw, table) {
  const list = parseLinkFilter(raw)
  if (!list.length) return []
  if (list.length > 10) throw new Error('Trop de conditions (10 maximum)')
  const allowed = new Set(linkFilterColumns(table).map(c => c.column))
  if (!allowed.size) throw new Error(`Table cible « ${table} » inconnue`)
  return list.map(c => {
    if (!allowed.has(c.column)) throw new Error(`Colonne « ${c.column} » introuvable dans ${table}`)
    if (!LINK_FILTER_OPS.has(c.op)) throw new Error(`Opérateur inconnu : ${c.op}`)
    if (VALUE_LESS.has(c.op)) return { column: c.column, op: c.op }
    if (MULTI_VALUE.has(c.op)) {
      if (!c.value.length) throw new Error('Valeur requise')
      return { column: c.column, op: c.op, value: c.value }
    }
    if (c.value === '') throw new Error('Valeur requise')
    return { column: c.column, op: c.op, value: c.value }
  })
}

// Lecture tolérante d'un filtre stocké (JSON string ou tableau déjà parsé) :
// tout ce qui n'a pas la forme attendue est ignoré plutôt que de faire tomber
// la liste de candidats.
export function parseLinkFilter(raw) {
  let list = raw
  if (typeof list === 'string') {
    const s = list.trim()
    if (!s) return []
    try { list = JSON.parse(s) } catch { return [] }
  }
  if (!Array.isArray(list)) return []
  return list
    .filter(c => c && typeof c === 'object' && SAFE_IDENT.test(String(c.column || '')))
    .map(c => {
      const op = String(c.op || 'is')
      // « est l'un des » / « n'est aucun des » : la valeur est une liste. Une
      // valeur scalaire (ancien filtre re-typé) compte pour une liste d'un.
      if (MULTI_VALUE.has(op)) {
        const arr = Array.isArray(c.value) ? c.value : (c.value == null || c.value === '' ? [] : [c.value])
        return {
          column: String(c.column),
          op,
          value: arr.map(v => String(v).trim()).filter(v => v !== ''),
        }
      }
      return {
        column: String(c.column),
        op,
        value: Array.isArray(c.value)
          ? String(c.value[0] ?? '').trim()
          : (c.value == null ? '' : String(c.value).trim()),
      }
    })
}

// Une valeur de condition comparée à une colonne : nombre quand elle en est un
// (une quantité, une case cochée), texte sinon. SQLite ne compare pas '5' et 5.
function coerce(v) {
  const s = String(v).trim()
  if (s !== '' && Number.isFinite(Number(s))) return Number(s)
  return s
}

// Traduit un filtre en clauses SQL + paramètres, pour la table portant l'alias
// `alias`. Les colonnes sont validées ici (pas d'interpolation d'un nom venu du
// client sans passer par cette porte).
export function linkFilterSql(filter, table, alias = 't') {
  const clauses = []
  const params = []
  const allowed = new Set(linkFilterColumns(table).map(c => c.column))
  for (const c of parseLinkFilter(filter)) {
    if (!allowed.has(c.column) || !LINK_FILTER_OPS.has(c.op)) continue
    const col = `${alias}.${c.column}`
    switch (c.op) {
      case 'is':
        clauses.push(`(${col} = ? OR LOWER(CAST(${col} AS TEXT)) = LOWER(?))`)
        params.push(coerce(c.value), c.value)
        break
      case 'is_not':
        clauses.push(`(${col} IS NULL OR (${col} <> ? AND LOWER(CAST(${col} AS TEXT)) <> LOWER(?)))`)
        params.push(coerce(c.value), c.value)
        break
      case 'is_any_of': {
        if (!c.value.length) break
        const ph = c.value.map(() => '?').join(',')
        clauses.push(`(${col} IN (${ph}) OR LOWER(CAST(${col} AS TEXT)) IN (${ph}))`)
        params.push(...c.value.map(coerce), ...c.value.map(v => v.toLowerCase()))
        break
      }
      case 'is_none_of': {
        if (!c.value.length) break
        const ph = c.value.map(() => '?').join(',')
        clauses.push(`(${col} IS NULL OR (${col} NOT IN (${ph}) AND LOWER(CAST(${col} AS TEXT)) NOT IN (${ph})))`)
        params.push(...c.value.map(coerce), ...c.value.map(v => v.toLowerCase()))
        break
      }
      case 'contains':
        clauses.push(`CAST(${col} AS TEXT) LIKE ?`)
        params.push(`%${c.value}%`)
        break
      case 'not_contains':
        clauses.push(`(${col} IS NULL OR CAST(${col} AS TEXT) NOT LIKE ?)`)
        params.push(`%${c.value}%`)
        break
      case 'empty':
        clauses.push(`(${col} IS NULL OR TRIM(CAST(${col} AS TEXT)) = '')`)
        break
      case 'not_empty':
        clauses.push(`(${col} IS NOT NULL AND TRIM(CAST(${col} AS TEXT)) <> '')`)
        break
      case 'gt':
        clauses.push(`${col} > ?`)
        params.push(coerce(c.value))
        break
      case 'lt':
        clauses.push(`${col} < ?`)
        params.push(coerce(c.value))
        break
      default:
        break
    }
  }
  return { clauses, params }
}
