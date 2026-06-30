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
    case 'is':           return str === val
    case 'not_equals':
    case 'is_not':       return str !== val
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
      if (!v || !value) return false
      return new Date(v) < new Date(value)
    }
    case 'is_after':
    case 'after': {
      if (!v || !value) return false
      return new Date(v) > new Date(value)
    }
    case 'between':
    case 'is_within': {
      // Plage de dates inclusive : value === [from, to] (YYYY-MM-DD). Tolère une
      // borne vide (devient un simple ≥ ou ≤). On compare en UTC pour rester
      // cohérent avec les dates métier encodées minuit UTC par Airtable, et on
      // rend la borne `to` inclusive sur toute la journée (+1 jour exclusif).
      if (!v) return false
      const arr = Array.isArray(value) ? value : []
      const from = arr[0]
      const to = arr[1]
      if (!from && !to) return false
      const t = new Date(v).getTime()
      if (Number.isNaN(t)) return false
      if (from) {
        const fromT = new Date(from).getTime()
        if (!Number.isNaN(fromT) && t < fromT) return false
      }
      if (to) {
        const toT = new Date(to).getTime()
        if (!Number.isNaN(toT) && t >= toT + 86400000) return false
      }
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
    case 'last_n_days': {
      if (!v || !value) return false
      const d = new Date(v)
      const now = new Date()
      const cutoff = new Date(now - Number(value) * 86400000)
      return d >= cutoff && d <= now
    }
    case 'more_than_n_days_ago': {
      if (!v || !value) return false
      const d = new Date(v)
      const cutoff = new Date(Date.now() - Number(value) * 86400000)
      return d < cutoff
    }
    case 'next_n_days': {
      if (!v || !value) return false
      const d = new Date(v)
      const now = new Date()
      const cutoff = new Date(now.getTime() + Number(value) * 86400000)
      return d >= now && d <= cutoff
    }
    case 'more_than_n_days_ahead': {
      if (!v || !value) return false
      const d = new Date(v)
      const cutoff = new Date(Date.now() + Number(value) * 86400000)
      return d > cutoff
    }
    case 'today': {
      if (!v) return false
      const d = localISODate(new Date(v))
      const t = localISODate()
      return d === t
    }
    case 'yesterday': {
      if (!v) return false
      const d = localISODate(new Date(v))
      const y = localISODate(new Date(Date.now() - 86400000))
      return d === y
    }
    case 'this_week': {
      if (!v) return false
      const d = new Date(v)
      const now = new Date()
      const day = now.getDay()
      const start = new Date(now)
      start.setDate(now.getDate() - (day === 0 ? 6 : day - 1))
      start.setHours(0, 0, 0, 0)
      const end = new Date(start)
      end.setDate(start.getDate() + 7)
      return d >= start && d < end
    }
    case 'this_month': {
      if (!v) return false
      const d = new Date(v)
      const now = new Date()
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()
    }
    case 'last_month': {
      if (!v) return false
      const d = new Date(v)
      const now = new Date()
      const lm = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      return d.getMonth() === lm.getMonth() && d.getFullYear() === lm.getFullYear()
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
