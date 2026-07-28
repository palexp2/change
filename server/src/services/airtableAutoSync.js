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

// ── Convert Airtable field value to ERP value ───────────────────────────────

// Cache statements pour la résolution des liens (par table cible).
const _linkResolverCache = new Map()
function resolveAirtableIdToErp(targetTable, airtableId) {
  if (!airtableId) return null
  let stmt = _linkResolverCache.get(targetTable)
  if (!stmt) {
    stmt = db.prepare(`SELECT id FROM ${targetTable} WHERE airtable_id=?`)
    _linkResolverCache.set(targetTable, stmt)
  }
  const row = stmt.get(airtableId)
  return row?.id || null
}

function convertValue(val, fieldType, options) {
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

    case 'link': {
      // Si la def porte une `link_target_table`, on résout chaque record ID
      // Airtable vers le UUID ERP correspondant. Sinon (legacy / pas configuré),
      // on stocke les IDs Airtable bruts comme avant.
      const arr = Array.isArray(val) ? val : [val]
      const target = options?.link_target_table
      if (target) {
        const resolved = arr.map(rid => resolveAirtableIdToErp(target, rid)).filter(Boolean)
        return JSON.stringify(resolved)
      }
      return JSON.stringify(arr)
    }

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

// ── Live table column lookup ────────────────────────────────────────────────

function liveColumns(table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name))
}

// Colonnes NOT NULL : la sync dynamique ne doit jamais y écrire — `convertValue`
// peut produire null pour un champ Airtable vide, ce qui violerait la contrainte
// et ferait rollback toute la transaction. Cf. incident projects.name de mai 2026
// où une def dynamique « Projet → name » écrasait la valeur posée par le sync
// hardcodé dès que le field_map_projects était vide.
function notNullColumns(table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().filter(c => c.notnull === 1).map(c => c.name))
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
  // Colonnes ERP gérées par la sync hardcodée — interdire qu'une def dynamique
  // pointe vers la même colonne sous un autre nom Airtable, sinon elle écrase
  // (ex : ancien champ Airtable "Coût unitaire" vs nouveau "Coût unitaire (FIFO)"
  // tous deux mappés vers products.unit_cost).
  const mappedErpColumns = new Set(Object.keys(hardcodedFieldMap || {}))
  const existingCols = liveColumns(erpTable)
  const existingDefs = db.prepare(
    'SELECT * FROM airtable_field_mappings WHERE erp_table=?'
  ).all(erpTable)
  const defsByAtId = new Map(existingDefs.map(d => [d.airtable_field_id, d]))
  const defsByName = new Map(existingDefs.map(d => [d.airtable_field_name, d]))

  let updatedFields = 0
  const dynamicFieldMap = [] // { airtableFieldName, columnName, fieldType }

  for (const atField of tableFields) {
    // Skip fields already handled by hardcoded map
    if (mappedAirtableFields.has(atField.name)) continue

    const mapped = mapAirtableType(atField)
    const existingDef = defsByAtId.get(atField.id) || defsByName.get(atField.name)

    // No def → field is unknown to the ERP; we no longer auto-create columns
    // for new Airtable fields, so simply skip.
    if (!existingDef) continue

    // Placeholder (`__pending__`) defs created via the sync modale never had
    // a real column attached — without auto-creation we just skip them.
    if (existingDef.column_name === '__pending__') continue

    // Update mapping metadata (nom du champ Airtable) sur le mapping existant.
    // Le field_type/options de RENDU vit désormais dans custom_fields et n'est
    // plus jamais réécrit par le sync entrant (changement de comportement
    // volontaire — un renommage/retype côté Airtable ne doit plus surprendre un
    // utilisateur qui a configuré le rendu ERP à la main). `mapped.field_type`/
    // `mapped.options`, dérivés à chaque passage des métadonnées Airtable
    // live, servent uniquement à convertir la VALEUR ci-dessous.
    if (existingDef.airtable_field_name !== atField.name) {
      db.prepare(
        "UPDATE airtable_field_mappings SET airtable_field_name=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?"
      ).run(atField.name, existingDef.id)
      updatedFields++
    }

    if (existingDef.import_disabled === 1) continue
    // Defensive: if the column was dropped manually, skip rather than crash.
    if (!existingCols.has(existingDef.column_name)) continue
    // Si une autre def Airtable mappe vers une colonne ERP gérée par le hardcoded
    // map, on l'ignore : sinon elle écraserait la valeur écrite par la sync
    // hardcodée (souvent avec NULL, quand l'ancien champ Airtable a été remplacé).
    if (mappedErpColumns.has(existingDef.column_name)) continue

    // `link_target_table` (résolution des liens Airtable→ERP) est une config de
    // MAPPING persistée sur airtable_field_mappings.options par la modale de
    // mapping (routes/connectors.js) — indépendante des options de rendu
    // dérivées ici des métadonnées Airtable (choices, precision, etc.).
    let mappingOptions = {}
    try { mappingOptions = JSON.parse(existingDef.options || '{}') } catch {}
    dynamicFieldMap.push({
      airtableFieldName: atField.name,
      columnName: existingDef.column_name,
      fieldType: mapped.field_type,
      options: { ...mapped.options, link_target_table: mappingOptions.link_target_table || null },
    })
  }

  // 3. Populate dynamic fields for all records (skip frozen + NOT NULL columns)
  const frozen = getFrozenColumns(erpTable)
  const notNull = notNullColumns(erpTable)
  const writable = dynamicFieldMap.filter(f => !frozen.has(f.columnName) && !notNull.has(f.columnName))
  if (writable.length > 0 && records.length > 0) {
    const updateStmt = writable.map(f => `${f.columnName}=?`).join(', ')
    const stmt = db.prepare(
      `UPDATE ${erpTable} SET ${updateStmt} WHERE airtable_id=?`
    )

    const populated = db.transaction((recs) => {
      let count = 0
      for (const rec of recs) {
        const values = writable.map(f => convertValue(rec.fields[f.airtableFieldName], f.fieldType, f.options))
        const result = stmt.run(...values, rec.id)
        if (result.changes > 0) count++
      }
      return count
    })(records)
    if (populated > 0) console.log(`🔄 ${module}: ${populated} records enrichis avec champs dynamiques`)
  }

  if (updatedFields > 0) console.log(`🔄 ${module}: ${updatedFields} types de champs mis à jour`)
}

/**
 * Lightweight dynamic field update for webhook records.
 * Uses existing airtable_field_defs only — no schema mutation, no new defs.
 * Fields seen in webhook payloads but unknown to airtable_field_defs are ignored.
 */
export function updateDynamicFields(erpTable, hardcodedFieldMap, records) {
  if (!records?.length) return

  // Le field_type/options de rendu vit désormais dans custom_fields (fusion
  // avec l'ex-airtable_field_defs) — JOIN pour la conversion de valeur.
  const defs = db.prepare(`
    SELECT m.*, cf.type AS render_type, cf.options AS render_options
    FROM airtable_field_mappings m
    LEFT JOIN custom_fields cf ON cf.erp_table = m.erp_table AND cf.column_name = m.column_name AND cf.deleted_at IS NULL
    WHERE m.erp_table=?
  `).all(erpTable)
  const mappedFields = new Set(Object.values(hardcodedFieldMap || {}).filter(v => typeof v === 'string'))
  // Voir syncDynamicFields pour la motivation : deux noms de champs Airtable
  // ne doivent pas se disputer la même colonne ERP.
  const mappedErpColumns = new Set(Object.keys(hardcodedFieldMap || {}))
  const existingCols = liveColumns(erpTable)

  // Build dynamic field list from existing defs only, en filtrant les champs
  // désactivés via la modale de sync, ceux gérés par le handler hardcodé
  // (sinon une def dynamique préexistante peut écraser ce que le sync
  // hardcodé a écrit — ex. products.image_url qui se faisait remplacer par
  // l'URL Airtable temporaire), les placeholders __pending__ et les defs
  // dont la colonne a été supprimée manuellement.
  const dynamicFields = []
  for (const d of defs) {
    if (d.import_disabled === 1) continue
    if (mappedFields.has(d.airtable_field_name)) continue
    if (mappedErpColumns.has(d.column_name)) continue
    if (d.column_name === '__pending__') continue
    if (!existingCols.has(d.column_name)) continue
    // `d.options` (colonne propre à airtable_field_mappings) porte link_target_table
    // — config de résolution du sync ; `d.render_options` (custom_fields.options)
    // porte les choices/format de rendu. On fusionne les deux pour convertValue.
    // Un champ lien Airtable migre vers custom_fields.type='text' (voir migration
    // schema.js — 'link' n'est pas un type de rendu sélectionnable) : la présence
    // de link_target_table est donc le seul signal fiable qu'il faut prendre le
    // chemin de résolution 'link' de convertValue plutôt que le rendu texte.
    let mappingOptions = {}
    try { mappingOptions = JSON.parse(d.options || '{}') } catch {}
    let renderOptions = {}
    try { renderOptions = JSON.parse(d.render_options || '{}') } catch {}
    const isLink = !!mappingOptions.link_target_table
    dynamicFields.push({
      airtableFieldName: d.airtable_field_name,
      columnName: d.column_name,
      fieldType: isLink ? 'link' : (d.render_type || 'text'),
      options: { ...renderOptions, link_target_table: mappingOptions.link_target_table || null },
    })
  }

  if (!dynamicFields.length) return

  const frozen = getFrozenColumns(erpTable)
  const notNull = notNullColumns(erpTable)
  const writable = dynamicFields.filter(f => !frozen.has(f.columnName) && !notNull.has(f.columnName))
  if (!writable.length) return

  const updateStmt = writable.map(f => `${f.columnName}=?`).join(', ')
  const stmt = db.prepare(`UPDATE ${erpTable} SET ${updateStmt} WHERE airtable_id=?`)

  const count = db.transaction((recs) => {
    let n = 0
    for (const rec of recs) {
      const values = writable.map(f => convertValue(rec.fields[f.airtableFieldName], f.fieldType, f.options))
      const result = stmt.run(...values, rec.id)
      if (result.changes > 0) n++
    }
    return n
  })(records)

  if (count > 0) console.log(`🔄 ${erpTable}: ${count} records enrichis (webhook)`)
}

/**
 * Register native (hardcoded) fields in airtable_field_mappings so they
 * appear in fieldRuleEngine's column whitelist (templates) alongside dynamic
 * Airtable fields. Ces defs 'native_*' ne migrent jamais vers custom_fields
 * (bruit inutile dans l'UI « champs custom ») — voir plan de fusion.
 * Runs at startup — idempotent (INSERT OR IGNORE).
 */
export function ensureNativeFieldDefs(definitions) {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO airtable_field_mappings (id, module, erp_table, airtable_field_id, airtable_field_name, column_name, sort_order)
     VALUES (?,?,?,?,?,?,?)`
  )
  let count = 0
  for (const def of definitions) {
    const result = stmt.run(
      uuid(), def.module, def.erp_table, `native_${def.column_name}`,
      def.label, def.column_name,
      def.sort_order ?? -(1000 - count)
    )
    if (result.changes > 0) count++
  }
  if (count > 0) console.log(`📋 ${count} native field(s) registered in airtable_field_mappings`)
}
