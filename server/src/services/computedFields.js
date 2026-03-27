/**
 * Computed fields: lookup, rollup, formula.
 * Uses batch queries to avoid N+1 when processing multiple records.
 */
import { evaluateFormula } from './formulaEngine.js'

// ── Batch helpers ─────────────────────────────────────────────────────────────

/**
 * Build link map: { sourceRecordId -> [targetRecordId, ...] } for a given fieldId.
 */
export function buildLinkMap(db, fieldId, recordIds) {
  if (!recordIds.length) return {}
  const placeholders = recordIds.map(() => '?').join(',')
  const links = db.prepare(
    `SELECT source_record_id, target_record_id FROM base_record_links
     WHERE field_id = ? AND source_record_id IN (${placeholders})`
  ).all(fieldId, ...recordIds)

  const map = {}
  for (const l of links) {
    if (!map[l.source_record_id]) map[l.source_record_id] = []
    map[l.source_record_id].push(l.target_record_id)
  }
  return map
}

/**
 * Fetch values for a specific key from a list of record IDs.
 * Returns: { recordId -> value }
 */
export function batchFetchValues(db, recordIds, fieldKey) {
  if (!recordIds.length) return {}
  const placeholders = recordIds.map(() => '?').join(',')
  const rows = db.prepare(
    `SELECT id, json_extract(data, '$.${fieldKey}') as val
     FROM base_records WHERE id IN (${placeholders}) AND deleted_at IS NULL`
  ).all(...recordIds)

  const map = {}
  for (const r of rows) map[r.id] = r.val
  return map
}

// ── Per-field computation ─────────────────────────────────────────────────────

function applyAggregate(values, aggregate) {
  const nums = values.map(Number).filter(n => !isNaN(n))
  switch (aggregate) {
    case 'SUM':    return nums.reduce((s, v) => s + v, 0)
    case 'AVG':    return nums.length ? nums.reduce((s, v) => s + v, 0) / nums.length : null
    case 'MIN':    return nums.length ? Math.min(...nums) : null
    case 'MAX':    return nums.length ? Math.max(...nums) : null
    case 'COUNT':  return values.length
    case 'CONCAT': return values.filter(v => v != null).join(', ')
    default:       return null
  }
}

export function computeLookup(targetIds, valueMap) {
  if (!targetIds?.length) return null
  const vals = targetIds.map(id => valueMap[id]).filter(v => v != null)
  return vals.length === 1 ? vals[0] : vals.length > 1 ? vals : null
}

export function computeRollup(targetIds, valueMap, aggregate) {
  if (!targetIds?.length) return aggregate === 'COUNT' ? 0 : null
  const values = targetIds.map(id => valueMap[id])
  return applyAggregate(values, aggregate)
}

// ── Batch enrichment for a list of records ────────────────────────────────────

/**
 * Enrich a list of parsed records with computed field values.
 * Groups queries by field to avoid N+1.
 *
 * @param {object} db - better-sqlite3 instance
 * @param {object[]} records - Array of { id, data (object), created_at, updated_at, ... }
 * @param {object[]} fields - Field definitions (with .type, .key, .options as parsed object)
 * @returns {object[]} Records with data enriched with computed values
 */
export function enrichRecords(db, records, fields) {
  if (!records.length) return records

  const recordIds = records.map(r => r.id)

  // Separate computed field types
  const formulaFields  = fields.filter(f => !f.deleted_at && f.type === 'formula')
  const lookupFields   = fields.filter(f => !f.deleted_at && f.type === 'lookup')
  const rollupFields   = fields.filter(f => !f.deleted_at && f.type === 'rollup')
  const createdAtField = fields.find(f => !f.deleted_at && f.type === 'created_at')
  const updatedAtField = fields.find(f => !f.deleted_at && f.type === 'updated_at')

  // Pre-build link maps and value maps for lookup/rollup (batch per field)
  // Structure: { fieldId -> { linkMap, valueMap } }
  const fieldCaches = {}

  const linkBasedFields = [...lookupFields, ...rollupFields]
  for (const field of linkBasedFields) {
    const opts = field.options
    if (!opts?.linkedFieldId && !opts?.linked_field_id) continue
    const linkedFieldId = opts.linkedFieldId || opts.linked_field_id
    const targetFieldKey = opts.targetFieldKey || opts.target_field_key

    if (!fieldCaches[field.id]) {
      const linkMap = buildLinkMap(db, linkedFieldId, recordIds)
      const allTargetIds = [...new Set(Object.values(linkMap).flat())]
      const valueMap = targetFieldKey ? batchFetchValues(db, allTargetIds, targetFieldKey) : {}
      fieldCaches[field.id] = { linkMap, valueMap, linkedFieldId, targetFieldKey }
    }
  }

  // Now enrich each record
  return records.map(record => {
    const data = { ...record.data }

    // created_at / updated_at virtual fields
    if (createdAtField) data[createdAtField.key] = record.created_at
    if (updatedAtField) data[updatedAtField.key] = record.updated_at

    // Formula fields (computed from data values)
    for (const field of formulaFields) {
      const formula = field.options?.formula || field.formula
      if (!formula) { data[field.key] = null; continue }
      data[field.key] = evaluateFormula(formula, data, fields)
    }

    // Lookup fields
    for (const field of lookupFields) {
      const cache = fieldCaches[field.id]
      if (!cache) { data[field.key] = null; continue }
      const targetIds = cache.linkMap[record.id] || []
      data[field.key] = computeLookup(targetIds, cache.valueMap)
    }

    // Rollup fields
    for (const field of rollupFields) {
      const cache = fieldCaches[field.id]
      if (!cache) { data[field.key] = null; continue }
      const targetIds = cache.linkMap[record.id] || []
      const aggregate = field.options?.aggregate || 'COUNT'
      data[field.key] = computeRollup(targetIds, cache.valueMap, aggregate)
    }

    return { ...record, data }
  })
}

