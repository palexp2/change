// ── Date helpers (no external deps) ──────────────────────────────────────────

function toDateStr(d) {
  return d.toISOString().split('T')[0]
}

function addDays(d, n) {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}

function startOfDay(d) {
  const r = new Date(d)
  r.setHours(0, 0, 0, 0)
  return r
}

function endOfDay(d) {
  const r = new Date(d)
  r.setHours(23, 59, 59, 999)
  return r
}

function startOfWeek(d) {
  const r = new Date(d)
  r.setDate(r.getDate() - r.getDay())
  r.setHours(0, 0, 0, 0)
  return r
}

function endOfWeek(d) {
  const r = new Date(d)
  r.setDate(r.getDate() + (6 - r.getDay()))
  r.setHours(23, 59, 59, 999)
  return r
}

function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

function endOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999)
}

function buildDateWithinSQL(col, period) {
  const now = new Date()
  let start, end

  switch (period) {
    case 'today':      start = startOfDay(now);   end = endOfDay(now);   break
    case 'this_week':  start = startOfWeek(now);  end = endOfWeek(now);  break
    case 'this_month': start = startOfMonth(now); end = endOfMonth(now); break
    case 'this_year':  start = new Date(now.getFullYear(), 0, 1); end = new Date(now.getFullYear(), 11, 31, 23, 59, 59); break
    case 'past_week':  start = addDays(now, -7);  end = now; break
    case 'past_month': start = addDays(now, -30); end = now; break
    case 'past_year':  start = addDays(now, -365); end = now; break
    case 'next_week':  start = now; end = addDays(now, 7);  break
    case 'next_month': start = now; end = addDays(now, 30); break
    case 'next_year':  start = now; end = addDays(now, 365); break
    default: return { sql: '1=1', params: [] }
  }

  return { sql: `${col} BETWEEN ? AND ?`, params: [toDateStr(start), toDateStr(end)] }
}

// ── Operator map ──────────────────────────────────────────────────────────────

const OPERATOR_MAP = {
  // Text
  'is':           (col, val) => ({ sql: `${col} = ?`, params: [val] }),
  'is_not':       (col, val) => ({ sql: `${col} != ?`, params: [val] }),
  'contains':     (col, val) => ({ sql: `${col} LIKE ?`, params: [`%${val}%`] }),
  'not_contains': (col, val) => ({ sql: `${col} NOT LIKE ?`, params: [`%${val}%`] }),
  'starts_with':  (col, val) => ({ sql: `${col} LIKE ?`, params: [`${val}%`] }),
  'ends_with':    (col, val) => ({ sql: `${col} LIKE ?`, params: [`%${val}`] }),

  // Numeric
  'eq':  (col, val) => ({ sql: `CAST(${col} AS REAL) = ?`,  params: [Number(val)] }),
  'neq': (col, val) => ({ sql: `CAST(${col} AS REAL) != ?`, params: [Number(val)] }),
  'gt':  (col, val) => ({ sql: `CAST(${col} AS REAL) > ?`,  params: [Number(val)] }),
  'gte': (col, val) => ({ sql: `CAST(${col} AS REAL) >= ?`, params: [Number(val)] }),
  'lt':  (col, val) => ({ sql: `CAST(${col} AS REAL) < ?`,  params: [Number(val)] }),
  'lte': (col, val) => ({ sql: `CAST(${col} AS REAL) <= ?`, params: [Number(val)] }),

  // Empty/not empty
  'is_empty':     (col) => ({ sql: `(${col} IS NULL OR ${col} = '' OR ${col} = '[]')`, params: [] }),
  'is_not_empty': (col) => ({ sql: `(${col} IS NOT NULL AND ${col} != '' AND ${col} != '[]')`, params: [] }),

  // Boolean
  'is_true':  (col) => ({ sql: `${col} = 1`, params: [] }),
  'is_false': (col) => ({ sql: `(${col} = 0 OR ${col} IS NULL)`, params: [] }),

  // Any-of / none-of (scalar)
  'is_any_of': (col, vals) => {
    const arr = Array.isArray(vals) ? vals : [vals]
    return { sql: `${col} IN (${arr.map(() => '?').join(',')})`, params: arr }
  },
  'is_none_of': (col, vals) => {
    const arr = Array.isArray(vals) ? vals : [vals]
    return { sql: `${col} NOT IN (${arr.map(() => '?').join(',')})`, params: arr }
  },

  // Multi-select (JSON array stored in data)
  'has_any_of': (col, vals) => {
    const arr = Array.isArray(vals) ? vals : [vals]
    return {
      sql: `(${arr.map(() => `${col} LIKE ?`).join(' OR ')})`,
      params: arr.map(v => `%"${v}"%`)
    }
  },
  'has_all_of': (col, vals) => {
    const arr = Array.isArray(vals) ? vals : [vals]
    return {
      sql: `(${arr.map(() => `${col} LIKE ?`).join(' AND ')})`,
      params: arr.map(v => `%"${v}"%`)
    }
  },
  'has_none_of': (col, vals) => {
    const arr = Array.isArray(vals) ? vals : [vals]
    return {
      sql: `(${arr.map(() => `${col} NOT LIKE ?`).join(' AND ')})`,
      params: arr.map(v => `%"${v}"%`)
    }
  },

  // Dates
  'is_before':  (col, val) => ({ sql: `${col} < ?`, params: [val] }),
  'is_after':   (col, val) => ({ sql: `${col} > ?`, params: [val] }),
  'is_within':  (col, val) => buildDateWithinSQL(col, val),
}

// ── Core builder ──────────────────────────────────────────────────────────────

function buildGroupSQL(group, depth = 0) {
  if (depth > 3) throw new Error('La profondeur des filtres dépasse le maximum (3)')

  const conjunction = (group.conjunction || 'AND').toUpperCase() === 'OR' ? 'OR' : 'AND'
  const parts = []
  const params = []

  for (const rule of (group.rules || [])) {
    if (rule.conjunction) {
      // Nested group
      const sub = buildGroupSQL(rule, depth + 1)
      parts.push(`(${sub.sql})`)
      params.push(...sub.params)
    } else {
      // Validate field_key
      if (!rule.field_key || !/^[a-zA-Z0-9_]+$/.test(rule.field_key)) continue
      const col = `json_extract(data, '$.${rule.field_key}')`
      const handler = OPERATOR_MAP[rule.op]
      if (!handler) continue
      const result = handler(col, rule.value)
      parts.push(result.sql)
      params.push(...result.params)
    }
  }

  return {
    sql: parts.length > 0 ? parts.join(` ${conjunction} `) : '1=1',
    params
  }
}

/**
 * Builds a SQL WHERE fragment from filter config.
 * Supports both simple (array) and advanced (object with conjunction) formats.
 * @param {array|object} filters
 * @returns {{ sql: string, params: any[] }}
 */
export function buildFilterSQL(filters) {
  if (!filters) return { sql: '1=1', params: [] }

  let group
  if (Array.isArray(filters)) {
    group = { conjunction: 'AND', rules: filters }
  } else if (filters.conjunction) {
    group = filters
  } else {
    return { sql: '1=1', params: [] }
  }

  return buildGroupSQL(group, 0)
}
