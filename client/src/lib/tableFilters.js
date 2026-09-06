// Logique pure de filtrage des tables — extrait de useTableView.js pour pouvoir
// être unit-testée sans charger React.

import { localISODate } from './formatDate.js'

function norm(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

function tryParseArr(v) {
  if (Array.isArray(v)) return v
  if (typeof v === 'string' && v.startsWith('[')) {
    try { return JSON.parse(v) } catch { return [] }
  }
  return v ? [v] : []
}

function isEmptyValue(v) {
  return v == null || v === '' || v === '[]' || (Array.isArray(v) && v.length === 0)
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
// "YYYY-MM-DDT00:00:00[.000]Z" — encodage Airtable d'un champ date-only : minuit
// UTC représente un jour calendaire, pas un instant (cf. fmtDate).
const UTC_MIDNIGHT_RE = /^\d{4}-\d{2}-\d{2}T00:00:00(\.0+)?Z$/

// Jour calendaire (YYYY-MM-DD) d'une valeur de champ date — exactement le jour
// que la table affiche pour cette cellule (même règle que fmtDate). Renvoie
// null si la valeur n'est pas une date.
//
// Sans ça, les filtres de date comparaient des instants à minuit UTC : « Après
// le 3 septembre » ramenait les enregistrements du 2 septembre au soir (fuseau
// de Montréal), et « Le 3 septembre » ne matchait jamais rien sur une colonne
// horodatée (comparaison de chaînes brutes : "2026-09-03T14:23:00.000Z" ≠
// "2026-09-03").
function dayKey(v) {
  if (v instanceof Date) {
    return Number.isNaN(v.getTime()) ? null : localISODate(v)
  }
  // Uniquement des chaînes : un nombre passé à `new Date()` donnerait une date
  // de 1970 et ferait passer un champ numérique pour une date.
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!s) return null
  if (DAY_RE.test(s)) return s
  if (UTC_MIDNIGHT_RE.test(s)) return s.slice(0, 10)
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return null
  return localISODate(d)
}

// Jour calendaire local décalé de `offsetDays`.
function todayKey(offsetDays = 0) {
  const d = new Date()
  if (offsetDays) d.setDate(d.getDate() + offsetDays)
  return localISODate(d)
}

export function applyFilter(row, filter, ctx = {}) {
  // Support both old format {field, op, value} and new format {field_key, operator, value}
  const field = filter.field_key || filter.field
  const op = filter.operator || filter.op
  const value = filter.value
  const v = row[field]
  const str = norm(v)
  const val = norm(value)
  switch (op) {
    case 'is_me':        return ctx.userName ? str === norm(ctx.userName) : false
    case 'is_not_me':    return ctx.userName ? str !== norm(ctx.userName) : true
    case 'contains':     return str.includes(val)
    case 'not_contains': return !str.includes(val)
    case 'equals':
    case 'is': {
      // Champ date comparé à un jour (YYYY-MM-DD, ce que produit le sélecteur) :
      // on compare le jour calendaire, pas la chaîne brute.
      const day = DAY_RE.test(String(value ?? '')) ? dayKey(v) : null
      if (day) return day === String(value)
      return str === val
    }
    case 'not_equals':
    case 'is_not': {
      const day = DAY_RE.test(String(value ?? '')) ? dayKey(v) : null
      if (day) return day !== String(value)
      return str !== val
    }
    case 'starts_with':  return str.startsWith(val)
    case 'ends_with':    return str.endsWith(val)
    case 'eq':           return Number(v) === Number(value)
    case 'neq':          return Number(v) !== Number(value)
    case 'gt':           return Number(v) > Number(value)
    case 'gte':          return Number(v) >= Number(value)
    case 'lt':           return Number(v) < Number(value)
    case 'lte':          return Number(v) <= Number(value)
    case 'is_empty':     return isEmptyValue(v)
    case 'is_not_empty': return !isEmptyValue(v)
    case 'is_true':      return v === 1 || v === true || v === '1'
    case 'is_false':     return v === 0 || v === false || v === '0' || v === null || v === undefined
    case 'is_before':
    case 'before': {
      // Règle pas encore renseignée (le sélecteur de date s'ouvre vide) : on ne
      // filtre rien, comme un « contient » sans texte. Sinon la table se vide dès
      // qu'on ajoute une condition de date, ce qui donne l'impression d'un bug.
      if (!value) return true
      if (!v) return false
      // Comparaison au jour près : « Avant le 3 » exclut toute la journée du 3,
      // quelle que soit l'heure de l'horodatage.
      const day = DAY_RE.test(String(value)) ? dayKey(v) : null
      if (day) return day < String(value)
      return new Date(v) < new Date(value)
    }
    case 'is_after':
    case 'after': {
      if (!value) return true
      if (!v) return false
      // « Après le 3 » exclut aussi toute la journée du 3 (symétrique de before).
      const day = DAY_RE.test(String(value)) ? dayKey(v) : null
      if (day) return day > String(value)
      return new Date(v) > new Date(value)
    }
    case 'between':
    case 'is_within': {
      // Plage de dates inclusive : value === [from, to] (YYYY-MM-DD). Tolère une
      // borne vide (devient un simple ≥ ou ≤). La comparaison se fait sur le jour
      // calendaire affiché (dayKey), donc les deux bornes couvrent leur journée
      // entière, y compris pour une colonne horodatée.
      const arr = Array.isArray(value) ? value : []
      const from = arr[0]
      const to = arr[1]
      if (!from && !to) return true   // plage vide → règle inactive
      if (!v) return false
      const day = dayKey(v)
      if (!day) return false
      if (from && day < from) return false
      if (to && day > to) return false
      return true
    }
    case 'is_any_of': {
      if (!value) return false
      const opts = Array.isArray(value) ? value : [value]
      return opts.some(o => norm(o) === str)
    }
    case 'is_none_of': {
      if (!value) return true
      const opts = Array.isArray(value) ? value : [value]
      return !opts.some(o => norm(o) === str)
    }
    case 'has_any_of': {
      const arr = tryParseArr(v)
      const opts = Array.isArray(value) ? value : [value]
      return opts.some(o => arr.includes(o))
    }
    case 'has_all_of': {
      const arr = tryParseArr(v)
      const opts = Array.isArray(value) ? value : [value]
      return opts.every(o => arr.includes(o))
    }
    case 'has_none_of': {
      const arr = tryParseArr(v)
      const opts = Array.isArray(value) ? value : [value]
      return !opts.some(o => arr.includes(o))
    }
    case 'is_exactly': {
      const arr = tryParseArr(v)
      const opts = Array.isArray(value) ? value : [value]
      return arr.length === opts.length && opts.every(o => arr.includes(o))
    }
    // Nombre de jours pas encore saisi → règle inactive (idem before/after).
    case 'last_n_days': {
      if (!value) return true
      if (!v) return false
      const d = new Date(v)
      const now = new Date()
      const cutoff = new Date(now - Number(value) * 86400000)
      return d >= cutoff && d <= now
    }
    case 'more_than_n_days_ago': {
      if (!value) return true
      if (!v) return false
      const d = new Date(v)
      const cutoff = new Date(Date.now() - Number(value) * 86400000)
      return d < cutoff
    }
    case 'next_n_days': {
      if (!value) return true
      if (!v) return false
      const d = new Date(v)
      const now = new Date()
      const cutoff = new Date(now.getTime() + Number(value) * 86400000)
      return d >= now && d <= cutoff
    }
    case 'more_than_n_days_ahead': {
      if (!value) return true
      if (!v) return false
      const d = new Date(v)
      const cutoff = new Date(Date.now() + Number(value) * 86400000)
      return d > cutoff
    }
    // Les opérateurs relatifs raisonnent sur le jour calendaire affiché : une
    // date métier encodée minuit UTC par Airtable ne doit pas basculer la veille.
    case 'today': {
      const day = dayKey(v)
      return !!day && day === todayKey()
    }
    case 'yesterday': {
      const day = dayKey(v)
      return !!day && day === todayKey(-1)
    }
    case 'this_week': {
      const day = dayKey(v)
      if (!day) return false
      const now = new Date()
      const dow = now.getDay()
      // Semaine du lundi au dimanche.
      const start = todayKey(-(dow === 0 ? 6 : dow - 1))
      const end = todayKey(-(dow === 0 ? 6 : dow - 1) + 6)
      return day >= start && day <= end
    }
    case 'this_month': {
      const day = dayKey(v)
      return !!day && day.slice(0, 7) === todayKey().slice(0, 7)
    }
    case 'last_month': {
      const day = dayKey(v)
      if (!day) return false
      const now = new Date()
      const lm = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      return day.slice(0, 7) === localISODate(lm).slice(0, 7)
    }
    default:             return true
  }
}

// Détecte un nœud "groupe" (parenthèses) vs une règle feuille.
export function isFilterGroup(node) {
  return !!(node && node.conjunction && Array.isArray(node.rules))
}

// Apply a nested filter group (conjunction + rules) to a row
export function applyFilterGroup(row, group, ctx = {}) {
  if (!group?.rules?.length) return true
  const method = group.conjunction === 'OR' ? 'some' : 'every'
  return group.rules[method](rule => {
    if (isFilterGroup(rule)) return applyFilterGroup(row, rule, ctx)
    return applyFilter(row, rule, ctx)
  })
}

// Compte les règles feuilles (les groupes ne comptent pas pour eux-mêmes) —
// utilisé pour le badge du bouton « Filtrer ». Accepte le format plat (array
// legacy) comme le format imbriqué ({conjunction, rules}).
export function countFilterRules(filters) {
  if (Array.isArray(filters)) return filters.length
  if (filters?.rules) {
    return filters.rules.reduce(
      (n, r) => n + (isFilterGroup(r) ? countFilterRules(r) : 1),
      0,
    )
  }
  return 0
}
