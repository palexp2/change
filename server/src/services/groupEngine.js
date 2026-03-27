// ── Date period detection helpers ─────────────────────────────────────────────

function detectDatePeriod(records, fieldKey) {
  const dates = records
    .map(r => r.data[fieldKey])
    .filter(Boolean)
    .map(d => new Date(d))
    .filter(d => !isNaN(d))

  if (!dates.length) return 'day'

  const min = Math.min(...dates.map(d => d.getTime()))
  const max = Math.max(...dates.map(d => d.getTime()))
  const diffMs = max - min
  const diffDays = diffMs / (1000 * 60 * 60 * 24)

  if (diffDays > 365) return 'year'
  if (diffDays > 30)  return 'month'
  if (diffDays > 7)   return 'week'
  return 'day'
}

function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

function groupKeyForDate(dateStr, period) {
  if (!dateStr) return null
  const d = new Date(dateStr)
  if (isNaN(d)) return dateStr
  switch (period) {
    case 'year':  return String(d.getFullYear())
    case 'month': return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    case 'week':  return isoWeek(d)
    case 'day':
    default:      return d.toISOString().split('T')[0]
  }
}

// ── Summary computation ───────────────────────────────────────────────────────

function computeSummaries(records, summariesConfig) {
  const result = {}
  for (const [key, aggregate] of Object.entries(summariesConfig)) {
    if (key === '_count') {
      result._count = records.length
      continue
    }
    const values = records
      .map(r => r.data[key])
      .filter(v => v != null && v !== '')
      .map(Number)
      .filter(n => !isNaN(n))

    switch (aggregate) {
      case 'SUM':   result[key] = values.reduce((s, v) => s + v, 0); break
      case 'AVG':   result[key] = values.length ? values.reduce((s, v) => s + v, 0) / values.length : null; break
      case 'MIN':   result[key] = values.length ? Math.min(...values) : null; break
      case 'MAX':   result[key] = values.length ? Math.max(...values) : null; break
      case 'COUNT': result[key] = values.length; break
      default:      result[key] = null
    }
  }
  return result
}

// ── Core grouping ─────────────────────────────────────────────────────────────

function groupLevel(records, groupByConfig, summariesConfig, fields, depth = 0) {
  if (!groupByConfig.length || depth >= 3) return null

  const { field_key, order = 'asc' } = groupByConfig[0]
  const restConfig = groupByConfig.slice(1)

  // Detect if field is date type
  const fieldDef = fields.find(f => f.key === field_key)
  const isDate = fieldDef && ['date', 'datetime', 'created_at', 'updated_at'].includes(fieldDef.type)
  const datePeriod = isDate ? detectDatePeriod(records, field_key) : null

  // Group records
  const groupMap = new Map()
  for (const rec of records) {
    let rawVal = rec.data[field_key] ?? null
    const groupKey = isDate ? groupKeyForDate(rawVal, datePeriod) : (rawVal ?? null)
    const keyStr = groupKey === null ? '__null__' : String(groupKey)

    if (!groupMap.has(keyStr)) {
      groupMap.set(keyStr, { value: groupKey, records: [] })
    }
    groupMap.get(keyStr).records.push(rec)
  }

  // Build groups array
  let groups = Array.from(groupMap.values()).map(g => {
    const summaries = computeSummaries(g.records, summariesConfig)
    const subgroups = restConfig.length ? groupLevel(g.records, restConfig, summariesConfig, fields, depth + 1) : null

    return {
      field_key,
      value: g.value,
      count: g.records.length,
      summaries,
      records: subgroups ? [] : g.records, // Only leaf groups carry records
      ...(subgroups ? { subgroups } : {}),
    }
  })

  // Sort groups
  groups.sort((a, b) => {
    const av = a.value, bv = b.value
    if (av === null) return 1
    if (bv === null) return -1
    const cmp = String(av).localeCompare(String(bv), undefined, { numeric: true })
    return order === 'desc' ? -cmp : cmp
  })

  return groups
}

/**
 * Groups an array of enriched records by the given config.
 * @param {object[]} records - Enriched records (data already parsed)
 * @param {object[]} groupByConfig - [{ field_key, order }]
 * @param {object}   summariesConfig - { field_key: aggregate, _count: true }
 * @param {object[]} fields - Field definitions
 * @returns {{ groups: object[], total: number }}
 */
export function groupRecords(records, groupByConfig, summariesConfig, fields) {
  if (!groupByConfig.length) return { groups: [], total: records.length }

  const groups = groupLevel(records, groupByConfig, summariesConfig, fields, 0)
  return { groups, total: records.length }
}
