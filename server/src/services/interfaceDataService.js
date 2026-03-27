import { buildFilterSQL } from './filterEngine.js'

/**
 * Combine config filters + dynamic filter-block values into a single SQL clause.
 */
function buildCombinedFilters(db, configFilters, filterBlockIds, filterValues) {
  const allRules = []

  if (Array.isArray(configFilters) && configFilters.length > 0) {
    allRules.push(...configFilters)
  } else if (configFilters && configFilters.rules) {
    allRules.push(...configFilters.rules)
  }

  if (filterBlockIds && filterBlockIds.length > 0) {
    for (const blockId of filterBlockIds) {
      const val = filterValues[blockId]
      if (val === undefined || val === null || val === '') continue

      const filterBlock = db.prepare('SELECT config FROM base_interface_blocks WHERE id = ?').get(blockId)
      if (!filterBlock) continue
      const filterConfig = JSON.parse(filterBlock.config || '{}')
      if (!filterConfig.field_key) continue

      allRules.push({ field_key: filterConfig.field_key, op: 'is', value: val })
    }
  }

  if (allRules.length === 0) return { sql: '1=1', params: [] }
  return buildFilterSQL({ conjunction: 'AND', rules: allRules })
}

/**
 * Bloc metric → { value, label, format }
 */
export async function computeMetricData(db, config, filterValues, tenantId) {
  const { table_id, field_key, aggregate, label, format, filters, filter_block_ids } = config
  if (!table_id) return { value: 0, label: label || '', format: format || 'number' }

  const combined = buildCombinedFilters(db, filters, filter_block_ids, filterValues)
  const agg = aggregate || 'COUNT'

  let query
  const params = [table_id, tenantId]

  if (agg === 'COUNT' || !field_key) {
    query = `SELECT COUNT(*) as val FROM base_records WHERE table_id = ? AND tenant_id = ? AND deleted_at IS NULL`
  } else {
    const sqlAgg = ['SUM', 'AVG', 'MIN', 'MAX'].includes(agg) ? agg : 'SUM'
    query = `SELECT ${sqlAgg}(CAST(json_extract(data, '$.${field_key}') AS REAL)) as val
             FROM base_records WHERE table_id = ? AND tenant_id = ? AND deleted_at IS NULL`
  }

  if (combined.sql !== '1=1') {
    query += ` AND (${combined.sql})`
    params.push(...combined.params)
  }

  const result = db.prepare(query).get(...params)
  return { value: result?.val ?? 0, label: label || '', format: format || 'number' }
}

/**
 * Bloc chart → { labels, datasets: [{ label, data }] }
 */
export async function computeChartData(db, config, filterValues, tenantId) {
  const { table_id, x_field_key, x_group_by, y_field_key, y_aggregate, label, filters, filter_block_ids } = config
  if (!table_id || !x_field_key) return { labels: [], datasets: [] }

  const combined = buildCombinedFilters(db, filters, filter_block_ids, filterValues)

  let groupExpr
  switch (x_group_by) {
    case 'day':   groupExpr = `date(json_extract(data, '$.${x_field_key}'))`; break
    case 'week':  groupExpr = `strftime('%Y-W%W', json_extract(data, '$.${x_field_key}'))`; break
    case 'month': groupExpr = `strftime('%Y-%m', json_extract(data, '$.${x_field_key}'))`; break
    case 'year':  groupExpr = `strftime('%Y', json_extract(data, '$.${x_field_key}'))`; break
    default:      groupExpr = `json_extract(data, '$.${x_field_key}')`; break
  }

  const aggExpr = y_field_key
    ? `${['SUM','AVG','MIN','MAX','COUNT'].includes(y_aggregate) ? y_aggregate : 'SUM'}(CAST(json_extract(data, '$.${y_field_key}') AS REAL))`
    : 'COUNT(*)'

  let query = `
    SELECT ${groupExpr} as x_val, ${aggExpr} as y_val
    FROM base_records
    WHERE table_id = ? AND tenant_id = ? AND deleted_at IS NULL
  `
  const params = [table_id, tenantId]

  if (combined.sql !== '1=1') {
    query += ` AND (${combined.sql})`
    params.push(...combined.params)
  }

  query += ` GROUP BY x_val ORDER BY x_val ASC`

  const rows = db.prepare(query).all(...params)
  return {
    labels: rows.map(r => r.x_val || '(vide)'),
    datasets: [{ label: label || '', data: rows.map(r => r.y_val || 0) }],
  }
}

/**
 * Bloc list → { data, total }
 */
export async function computeListData(db, config, filterValues, tenantId) {
  const { table_id, view_id, limit, filter_block_ids } = config
  if (!table_id) return { data: [], total: 0 }

  let viewFilters = null
  let viewSorts = []
  if (view_id) {
    const view = db.prepare('SELECT * FROM base_views WHERE id = ?').get(view_id)
    if (view) {
      try { viewFilters = JSON.parse(view.filters || 'null') } catch {}
      try { viewSorts = JSON.parse(view.sorts || '[]') } catch {}
    }
  }

  const combined = buildCombinedFilters(db, viewFilters, filter_block_ids, filterValues)

  let query = `SELECT * FROM base_records WHERE table_id = ? AND tenant_id = ? AND deleted_at IS NULL`
  const params = [table_id, tenantId]

  if (combined.sql !== '1=1') {
    query += ` AND (${combined.sql})`
    params.push(...combined.params)
  }

  if (viewSorts.length > 0) {
    const orderParts = viewSorts.map(s =>
      `json_extract(data, '$.${s.field_key}') ${s.direction === 'desc' ? 'DESC' : 'ASC'}`
    )
    query += ` ORDER BY ${orderParts.join(', ')}`
  } else {
    query += ` ORDER BY row_order ASC`
  }

  const countQuery = query.replace('SELECT *', 'SELECT COUNT(*) as total')
  const total = db.prepare(countQuery).get(...params)?.total || 0

  query += ` LIMIT ?`
  params.push(limit || 50)

  const records = db.prepare(query).all(...params).map(r => {
    try { return { ...r, data: JSON.parse(r.data) } } catch { return r }
  })

  return { data: records, total }
}
