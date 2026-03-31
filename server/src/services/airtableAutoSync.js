/**
 * Airtable Auto-Sync — automatically imports ALL fields from an Airtable table
 * into the ERP, creating columns and storing field metadata dynamically.
 */
import { v4 as uuid } from 'uuid'
import db from '../db/database.js'
import { getAccessToken, airtableFetch } from '../connectors/airtable.js'

// ── Airtable type → ERP type mapping ────────────────────────────────────────

function mapAirtableType(atField) {
  const t = atField.type
  switch (t) {
    case 'singleLineText':
    case 'richText':
    case 'barcode':
    case 'externalSyncSource':
      return { field_type: 'text', options: {} }

    case 'multilineText':
      return { field_type: 'long_text', options: {} }

    case 'number':
    case 'count':
    case 'autoNumber':
      return { field_type: 'number', options: { precision: atField.options?.precision } }

    case 'currency':
      return { field_type: 'number', options: { format: 'currency', symbol: atField.options?.symbol } }

    case 'percent':
      return { field_type: 'number', options: { format: 'percent' } }

    case 'singleSelect':
      return {
        field_type: 'single_select',
        options: { choices: (atField.options?.choices || []).map(c => c.name) },
      }

    case 'multipleSelects':
      return {
        field_type: 'multi_select',
        options: { choices: (atField.options?.choices || []).map(c => c.name) },
      }

    case 'checkbox':
      return { field_type: 'checkbox', options: {} }

    case 'date':
    case 'dateTime':
    case 'createdTime':
    case 'lastModifiedTime':
      return { field_type: 'date', options: {} }

    case 'email':
      return { field_type: 'text', options: { format: 'email' } }

    case 'url':
      return { field_type: 'text', options: { format: 'url' } }

    case 'phoneNumber':
      return { field_type: 'text', options: { format: 'phone' } }

    case 'rating':
      return { field_type: 'number', options: { format: 'rating', max: atField.options?.max } }

    case 'multipleRecordLinks':
      return {
        field_type: 'link',
        options: { linked_table_id: atField.options?.linkedTableId },
      }

    case 'rollup':
    case 'lookup':
    case 'multipleLookupValues':
      return { field_type: 'text', options: { source: t } }

    case 'formula':
      return { field_type: 'text', options: { source: 'formula' } }

    case 'multipleAttachments':
      return { field_type: 'text', options: { format: 'attachment' } }

    default:
      return { field_type: 'text', options: {} }
  }
}

// ── Slugify field name → valid SQLite column name ───────────────────────────

function slugify(name) {
  return name
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 63) || 'field'
}

// Reserved SQLite / ERP column names to avoid collisions
const RESERVED = new Set([
  'id', 'tenant_id', 'airtable_id', 'created_at', 'updated_at', 'deleted_at',
  'rowid', 'oid', '_rowid_',
])

function safeColumnName(name, existingCols) {
  let slug = slugify(name)
  if (RESERVED.has(slug)) slug = `at_${slug}`
  // Avoid collisions with existing columns
  let final = slug
  let i = 2
  while (existingCols.has(final)) {
    final = `${slug}_${i++}`
  }
  return final
}

// ── Convert Airtable field value to ERP value ───────────────────────────────

function convertValue(val, fieldType) {
  if (val === null || val === undefined) return null

  switch (fieldType) {
    case 'single_select':
      return typeof val === 'string' ? val : String(val)

    case 'multi_select':
      return Array.isArray(val) ? JSON.stringify(val) : JSON.stringify([val])

    case 'checkbox':
      return val ? 1 : 0

    case 'number':
      return typeof val === 'number' ? val : null

    case 'date':
      return val ? new Date(val).toISOString() : null

    case 'link':
      // Store raw Airtable record IDs as JSON array (for display/reference)
      return Array.isArray(val) ? JSON.stringify(val) : JSON.stringify([val])

    case 'text':
    case 'long_text':
    default:
      if (Array.isArray(val)) {
        // Attachments, lookups, etc. — flatten to text
        return val.map(v => typeof v === 'object' ? (v.url || v.name || JSON.stringify(v)) : String(v)).join(', ')
      }
      if (typeof val === 'object') return JSON.stringify(val)
      return String(val)
  }
}

// ── Ensure column exists in SQLite table ────────────────────────────────────

const _tableColumns = new Map()

function getTableColumns(table) {
  if (!_tableColumns.has(table)) {
    _tableColumns.set(table, new Set(
      db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name)
    ))
  }
  return _tableColumns.get(table)
}

function ensureColumn(table, colName) {
  const cols = getTableColumns(table)
  if (!cols.has(colName)) {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${colName} TEXT`).run()
    cols.add(colName)
    console.log(`🔧 Auto-created column ${table}.${colName}`)
  }
}

// ── Main: sync all fields for a module ──────────────────────────────────────

/**
 * Sync ALL Airtable fields (not just hardcoded ones) for a given module.
 * Call this AFTER the regular sync has already handled the known fields.
 *
 * @param {string} tenantId
 * @param {string} module - e.g. 'billets', 'achats'
 * @param {string} erpTable - e.g. 'tickets', 'purchases'
 * @param {string} airtableBaseId
 * @param {string} airtableTableId
 * @param {Object} hardcodedFieldMap - the existing field_map (to skip already-mapped fields)
 * @param {Array} records - Airtable records (already fetched by the regular sync)
 */
export async function syncDynamicFields(tenantId, module, erpTable, airtableBaseId, airtableTableId, hardcodedFieldMap, records) {
  let accessToken
  try { accessToken = await getAccessToken(tenantId) } catch { return }

  // 1. Fetch table metadata from Airtable
  let tableFields
  try {
    const meta = await airtableFetch(`/meta/bases/${airtableBaseId}/tables`, accessToken)
    const table = (meta.tables || []).find(t => t.id === airtableTableId)
    if (!table) { console.log(`⚠️  Table ${airtableTableId} not found in Airtable metadata`); return }
    tableFields = table.fields || []
  } catch (e) {
    console.error(`❌ Airtable metadata fetch failed: ${e.message}`)
    return
  }

  // 2. Determine which fields are NOT in the hardcoded map
  const mappedAirtableFields = new Set(Object.values(hardcodedFieldMap || {}).filter(Boolean))
  const existingCols = getTableColumns(erpTable)
  const existingDefs = db.prepare(
    'SELECT * FROM airtable_field_defs WHERE tenant_id=? AND erp_table=?'
  ).all(tenantId, erpTable)
  const defsByAtId = new Map(existingDefs.map(d => [d.airtable_field_id, d]))

  let newFields = 0
  let updatedFields = 0
  const dynamicFieldMap = [] // { airtableFieldName, columnName, fieldType }

  for (const atField of tableFields) {
    // Skip fields already handled by hardcoded map
    if (mappedAirtableFields.has(atField.name)) continue

    const mapped = mapAirtableType(atField)
    const existingDef = defsByAtId.get(atField.id)

    if (existingDef) {
      // Field exists — check if type changed
      const oldType = existingDef.field_type
      const oldOptions = existingDef.options
      if (oldType !== mapped.field_type || oldOptions !== JSON.stringify(mapped.options)) {
        db.prepare(
          'UPDATE airtable_field_defs SET field_type=?, options=?, airtable_field_name=?, updated_at=datetime(\'now\') WHERE id=?'
        ).run(mapped.field_type, JSON.stringify(mapped.options), atField.name, existingDef.id)
        updatedFields++
      }
      dynamicFieldMap.push({
        airtableFieldName: atField.name,
        columnName: existingDef.column_name,
        fieldType: mapped.field_type,
      })
    } else {
      // New field — create column and store definition
      const colName = safeColumnName(atField.name, existingCols)
      ensureColumn(erpTable, colName)

      const sortOrder = existingDefs.length + newFields
      db.prepare(
        `INSERT INTO airtable_field_defs (id, tenant_id, module, erp_table, airtable_field_id, airtable_field_name, column_name, field_type, options, sort_order)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      ).run(uuid(), tenantId, module, erpTable, atField.id, atField.name, colName, mapped.field_type, JSON.stringify(mapped.options), sortOrder)

      dynamicFieldMap.push({
        airtableFieldName: atField.name,
        columnName: colName,
        fieldType: mapped.field_type,
      })
      existingCols.add(colName)
      newFields++
    }
  }

  // 3. Populate dynamic fields for all records
  if (dynamicFieldMap.length > 0 && records.length > 0) {
    const updateStmt = dynamicFieldMap.map(f => `${f.columnName}=?`).join(', ')
    const stmt = db.prepare(
      `UPDATE ${erpTable} SET ${updateStmt} WHERE tenant_id=? AND airtable_id=?`
    )

    const populated = db.transaction((recs) => {
      let count = 0
      for (const rec of recs) {
        const values = dynamicFieldMap.map(f => convertValue(rec.fields[f.airtableFieldName], f.fieldType))
        const result = stmt.run(...values, tenantId, rec.id)
        if (result.changes > 0) count++
      }
      return count
    })(records)
    if (populated > 0) console.log(`🔄 ${module}: ${populated} records enrichis avec champs dynamiques`)
  }

  if (newFields > 0) console.log(`✨ ${module}: ${newFields} nouveaux champs créés`)
  if (updatedFields > 0) console.log(`🔄 ${module}: ${updatedFields} types de champs mis à jour`)
}
