/**
 * Airtable Auto-Sync — automatically imports ALL fields from an Airtable table
 * into the ERP, creating columns and storing field metadata dynamically.
 */
import { v4 as uuid } from 'uuid'
import db from '../db/database.js'
import { getAccessToken, airtableFetch } from '../connectors/airtable.js'
import { getFrozenColumns } from './airtableFrozenColumns.js'

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
    case 'formula': {
      // Use the result type if available (e.g. formula returning a number)
      const resultType = atField.options?.result?.type
      if (resultType === 'number' || resultType === 'currency' || resultType === 'percent')
        return { field_type: 'number', options: { source: t, precision: atField.options?.result?.options?.precision } }
      if (resultType === 'date' || resultType === 'dateTime')
        return { field_type: 'date', options: { source: t } }
      if (resultType === 'checkbox')
        return { field_type: 'checkbox', options: { source: t } }
      return { field_type: 'text', options: { source: t } }
    }

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
  'id', 'airtable_id', 'created_at', 'updated_at', 'deleted_at',
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

    case 'date': {
      if (!val) return null
      const d = new Date(val)
      return isNaN(d.getTime()) ? null : d.toISOString()
    }

    case 'link':
      // Store raw Airtable record IDs as JSON array (for display/reference)
      return Array.isArray(val) ? JSON.stringify(val) : JSON.stringify([val])

    case 'text':
    case 'long_text':
    default:
      if (Array.isArray(val)) {
        // Attachments, lookups, etc. — flatten to text
        return val.map(v => v == null ? '' : typeof v === 'object' ? (v.url || v.name || JSON.stringify(v)) : String(v)).join(', ')
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

function refreshTableColumns(table) {
  _tableColumns.set(table, new Set(
    db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name)
  ))
  return _tableColumns.get(table)
}

function ensureColumn(table, colName) {
  const cols = getTableColumns(table)
  if (!cols.has(colName)) {
    // Confirm against live schema before ALTER — cache may be stale vs. another
    // connection / startup having already created the column.
    const live = refreshTableColumns(table)
    if (live.has(colName)) return
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${colName} TEXT`).run()
    live.add(colName)
    console.log(`🔧 Auto-created column ${table}.${colName}`)
  }
}

// ── Main: sync all fields for a module ──────────────────────────────────────

/**
 * Sync ALL Airtable fields (not just hardcoded ones) for a given module.
 * Call this AFTER the regular sync has already handled the known fields.
 *
 * @param {string} module - e.g. 'billets', 'achats'
 * @param {string} erpTable - e.g. 'tickets', 'purchases'
 * @param {string} airtableBaseId
 * @param {string} airtableTableId
 * @param {Object} hardcodedFieldMap - the existing field_map (to skip already-mapped fields)
 * @param {Array} records - Airtable records (already fetched by the regular sync)
 */
export async function syncDynamicFields(module, erpTable, airtableBaseId, airtableTableId, hardcodedFieldMap, records) {
  let accessToken
  try { accessToken = await getAccessToken() } catch { return }

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
  const mappedAirtableFields = new Set(Object.values(hardcodedFieldMap || {}).filter(v => typeof v === 'string'))
  const existingCols = getTableColumns(erpTable)
  const existingDefs = db.prepare(
    'SELECT * FROM airtable_field_defs WHERE erp_table=?'
  ).all(erpTable)
  const defsByAtId = new Map(existingDefs.map(d => [d.airtable_field_id, d]))
  const defsByName = new Map(existingDefs.map(d => [d.airtable_field_name, d]))

  let newFields = 0
  let updatedFields = 0
  const dynamicFieldMap = [] // { airtableFieldName, columnName, fieldType }

  for (const atField of tableFields) {
    // Skip fields already handled by hardcoded map
    if (mappedAirtableFields.has(atField.name)) continue

    const mapped = mapAirtableType(atField)
    // On retrouve une def soit par airtable_field_id, soit par nom — utile
    // pour les placeholders créés via la modale (id `pending_*`).
    let existingDef = defsByAtId.get(atField.id) || defsByName.get(atField.name)
    if (existingDef && existingDef.column_name === '__pending__') {
      // Promote le placeholder : crée la vraie colonne et MAJ la def avec le bon id + column_name.
      const colName = safeColumnName(atField.name, existingCols)
      ensureColumn(erpTable, colName)
      existingCols.add(colName)
      db.prepare(
        "UPDATE airtable_field_defs SET airtable_field_id=?, column_name=?, field_type=?, options=?, updated_at=datetime('now') WHERE id=?"
      ).run(atField.id, colName, mapped.field_type, JSON.stringify(mapped.options), existingDef.id)
      existingDef = { ...existingDef, airtable_field_id: atField.id, column_name: colName, field_type: mapped.field_type }
    }

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
      // Si le champ a été désactivé via la modale de sync, on ne l'ajoute pas
      // à la liste des fields à écrire — il est skippé.
      if (existingDef.import_disabled === 1) continue
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
        `INSERT INTO airtable_field_defs (id, module, erp_table, airtable_field_id, airtable_field_name, column_name, field_type, options, sort_order)
         VALUES (?,?,?,?,?,?,?,?,?)`
      ).run(uuid(), module, erpTable, atField.id, atField.name, colName, mapped.field_type, JSON.stringify(mapped.options), sortOrder)

      dynamicFieldMap.push({
        airtableFieldName: atField.name,
        columnName: colName,
        fieldType: mapped.field_type,
      })
      existingCols.add(colName)
      newFields++
    }
  }

  // 3. Populate dynamic fields for all records (skip frozen columns)
  const frozen = getFrozenColumns(erpTable)
  const writable = dynamicFieldMap.filter(f => !frozen.has(f.columnName))
  if (writable.length > 0 && records.length > 0) {
    const updateStmt = writable.map(f => `${f.columnName}=?`).join(', ')
    const stmt = db.prepare(
      `UPDATE ${erpTable} SET ${updateStmt} WHERE airtable_id=?`
    )

    const populated = db.transaction((recs) => {
      let count = 0
      for (const rec of recs) {
        const values = writable.map(f => convertValue(rec.fields[f.airtableFieldName], f.fieldType))
        const result = stmt.run(...values, rec.id)
        if (result.changes > 0) count++
      }
      return count
    })(records)
    if (populated > 0) console.log(`🔄 ${module}: ${populated} records enrichis avec champs dynamiques`)
  }

  if (newFields > 0) console.log(`✨ ${module}: ${newFields} nouveaux champs créés`)
  if (updatedFields > 0) console.log(`🔄 ${module}: ${updatedFields} types de champs mis à jour`)
}

/**
 * Lightweight dynamic field update for webhook records.
 * Uses existing airtable_field_defs (no Airtable metadata fetch needed).
 * New fields not yet in field_defs are auto-created as TEXT columns.
 */
export function updateDynamicFields(erpTable, hardcodedFieldMap, records) {
  if (!records?.length) return

  const defs = db.prepare('SELECT * FROM airtable_field_defs WHERE erp_table=?').all(erpTable)
  const defsByName = new Map(defs.map(d => [d.airtable_field_name, d]))
  const mappedFields = new Set(Object.values(hardcodedFieldMap || {}).filter(v => typeof v === 'string'))
  // Fields disabled via la modale → skip dans tout ce qui suit (creation de
  // colonnes pour nouveaux champs + écriture lors du sync).
  const disabledFieldNames = new Set(defs.filter(d => d.import_disabled === 1).map(d => d.airtable_field_name))
  // Refresh cache from live schema — guards against drift between
  // airtable_field_defs and actual table columns (e.g. schema rebuilt).
  const existingCols = refreshTableColumns(erpTable)
  // Self-heal: any def whose column is missing gets created now, so the
  // UPDATE statement below doesn't fail with "no such column".
  for (const d of defs) ensureColumn(erpTable, d.column_name)

  // Detect new fields from records that aren't in hardcoded map or field_defs.
  // On crée la def + colonne pour les nouveaux champs, mais SI le champ a déjà
  // une def avec import_disabled=1, on ne fait rien (on skipe).
  const seenNewFields = new Map() // airtableFieldName → colName
  for (const rec of records) {
    for (const fieldName of Object.keys(rec.fields || {})) {
      if (mappedFields.has(fieldName)) continue
      if (defsByName.has(fieldName)) continue
      if (disabledFieldNames.has(fieldName)) continue
      if (seenNewFields.has(fieldName)) continue
      // New field — create column and field_def
      const colName = safeColumnName(fieldName, existingCols)
      ensureColumn(erpTable, colName)
      existingCols.add(colName)
      const module = defs[0]?.module || erpTable
      db.prepare(
        `INSERT INTO airtable_field_defs (id, module, erp_table, airtable_field_id, airtable_field_name, column_name, field_type, options, sort_order)
         VALUES (?,?,?,?,?,?,?,?,?)`
      ).run(uuid(), module, erpTable, `webhook_${slugify(fieldName)}`, fieldName, colName, 'text', '{}', defs.length + seenNewFields.size)
      seenNewFields.set(fieldName, colName)
    }
  }

  // Build dynamic field list (existing defs + newly created), en filtrant
  // les champs désactivés via la modale de sync.
  const dynamicFields = []
  for (const d of defs) {
    if (d.import_disabled === 1) continue
    dynamicFields.push({ airtableFieldName: d.airtable_field_name, columnName: d.column_name, fieldType: d.field_type })
  }
  for (const [fieldName, colName] of seenNewFields) {
    dynamicFields.push({ airtableFieldName: fieldName, columnName: colName, fieldType: 'text' })
  }

  if (!dynamicFields.length) return

  const frozen = getFrozenColumns(erpTable)
  const writable = dynamicFields.filter(f => !frozen.has(f.columnName))
  if (!writable.length) return

  const updateStmt = writable.map(f => `${f.columnName}=?`).join(', ')
  const stmt = db.prepare(`UPDATE ${erpTable} SET ${updateStmt} WHERE airtable_id=?`)

  const count = db.transaction((recs) => {
    let n = 0
    for (const rec of recs) {
      const values = writable.map(f => convertValue(rec.fields[f.airtableFieldName], f.fieldType))
      const result = stmt.run(...values, rec.id)
      if (result.changes > 0) n++
    }
    return n
  })(records)

  if (seenNewFields.size > 0) console.log(`✨ ${erpTable}: ${seenNewFields.size} nouveaux champs (webhook)`)
  if (count > 0) console.log(`🔄 ${erpTable}: ${count} records enrichis (webhook)`)
}

/**
 * Register native (hardcoded) fields in airtable_field_defs so they appear
 * in the views/filter UI alongside dynamic Airtable fields.
 * Runs at startup — idempotent (INSERT OR IGNORE).
 */
export function ensureNativeFieldDefs(definitions) {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO airtable_field_defs (id, module, erp_table, airtable_field_id, airtable_field_name, column_name, field_type, options, sort_order)
     VALUES (?,?,?,?,?,?,?,?,?)`
  )
  let count = 0
  for (const def of definitions) {
    const result = stmt.run(
      uuid(), def.module, def.erp_table, `native_${def.column_name}`,
      def.label, def.column_name, def.field_type || 'text', JSON.stringify(def.options || {}),
      def.sort_order ?? -(1000 - count)
    )
    if (result.changes > 0) count++
  }
  if (count > 0) console.log(`📋 ${count} native field(s) registered in airtable_field_defs`)
}
