import db from '../db/database.js'
import { newId } from '../utils/ids.js'
import { buildFilterSQL } from './filterEngine.js'
import { enrichRecords } from './computedFields.js'
import { groupRecords } from './groupEngine.js'
import { checkAndRunAutomations } from './automationTriggers.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

function slugify(str) {
  return str.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '-') || 'table'
}

function toKey(str) {
  return str.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s_]/g, '')
    .trim()
    .replace(/[\s-]+/g, '_') || 'champ'
}

function safeKey(key) {
  return /^[a-zA-Z0-9_]+$/.test(key) ? key : null
}

function uniqueSlug(name, excludeId = null) {
  const base = slugify(name)
  let slug = base
  let n = 1
  while (true) {
    const row = db.prepare('SELECT id FROM base_tables WHERE slug = ?').get(slug)
    if (!row || row.id === excludeId) return slug
    slug = `${base}-${++n}`
  }
}

function uniqueKey(tableId, key, excludeId = null) {
  const base = toKey(key)
  let k = base
  let n = 1
  while (true) {
    const row = db.prepare('SELECT id FROM base_fields WHERE table_id = ? AND key = ?').get(tableId, k)
    if (!row || row.id === excludeId) return k
    k = `${base}_${++n}`
  }
}

function parseRecord(row) {
  if (!row) return null
  try { return { ...row, data: JSON.parse(row.data || '{}') } } catch { return { ...row, data: {} } }
}

function parseView(row) {
  if (!row) return null
  try { return { ...row, config: JSON.parse(row.config || '{}') } } catch { return { ...row, config: {} } }
}

function ownsTable(tableId) {
  return db.prepare('SELECT id FROM base_tables WHERE id = ?').get(tableId)
}

function ownsField(fieldId) {
  return db.prepare(`
    SELECT f.id, f.table_id, f.is_primary, f.type, f.options, f.key, f.deleted_at
    FROM base_fields f
    WHERE f.id = ?
  `).get(fieldId)
}

function ownsRecord(recordId) {
  return db.prepare(`
    SELECT r.* FROM base_records r
    WHERE r.id = ?
  `).get(recordId)
}

function ownsView(viewId) {
  return db.prepare(`
    SELECT v.* FROM base_views v
    WHERE v.id = ?
  `).get(viewId)
}

function recordCount(tableId) {
  return db.prepare('SELECT COUNT(*) as c FROM base_records WHERE table_id = ? AND deleted_at IS NULL').get(tableId).c
}

// ── Tables ────────────────────────────────────────────────────────────────────

export function getTables() {
  const tables = db.prepare(`
    SELECT * FROM base_tables WHERE deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC
  `).all()
  return tables.map(t => ({ ...t, record_count: recordCount(t.id) }))
}

export function createTable({ name, icon = null, color = null, description = null }) {
  const tableId = newId('table')
  const fieldId = newId('field')
  const viewId  = newId('view')
  const slug    = uniqueSlug(name)
  const key     = 'name'

  const run = db.transaction(() => {
    db.prepare(`
      INSERT INTO base_tables (id, name, slug, icon, color, description, sort_order, autonumber_seq)
      VALUES (?, ?, ?, ?, ?, ?, 0, 0)
    `).run(tableId, name, slug, icon, color, description)

    db.prepare(`
      INSERT INTO base_fields (id, table_id, name, key, type, options, is_primary, required, sort_order, width)
      VALUES (?, ?, 'Nom', ?, 'text', '{}', 1, 1, 0, 200)
    `).run(fieldId, tableId, key)

    db.prepare(`
      INSERT INTO base_views (id, table_id, name, type, config, sort_order, is_default)
      VALUES (?, ?, 'Tous', 'grid', ?, 0, 1)
    `).run(viewId, tableId, JSON.stringify({ visible_fields: [fieldId], field_order: [fieldId], filters: [], sorts: [], frozen_fields_count: 0 }))
  })
  run()

  const table = db.prepare('SELECT * FROM base_tables WHERE id = ?').get(tableId)
  const field = db.prepare('SELECT * FROM base_fields WHERE id = ?').get(fieldId)
  const view  = parseView(db.prepare('SELECT * FROM base_views WHERE id = ?').get(viewId))
  return { ...table, record_count: 0, primary_field: field, default_view: view }
}

export function updateTable(tableId, { name, icon, color, description, sort_order }) {
  const table = db.prepare('SELECT * FROM base_tables WHERE id = ?').get(tableId)
  if (!table) return null

  const newName = name !== undefined ? name : table.name
  const newSlug = name !== undefined ? uniqueSlug(name, tableId) : table.slug

  db.prepare(`
    UPDATE base_tables SET
      name = ?, slug = ?,
      icon = COALESCE(?, icon),
      color = COALESCE(?, color),
      description = COALESCE(?, description),
      sort_order = COALESCE(?, sort_order),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(newName, newSlug,
    icon !== undefined ? icon : null,
    color !== undefined ? color : null,
    description !== undefined ? description : null,
    sort_order !== undefined ? sort_order : null,
    tableId)

  return { ...db.prepare('SELECT * FROM base_tables WHERE id = ?').get(tableId), record_count: recordCount(tableId) }
}

export function deleteTable(tableId) {
  const table = db.prepare('SELECT id FROM base_tables WHERE id = ? AND deleted_at IS NULL').get(tableId)
  if (!table) return null
  db.prepare("UPDATE base_tables SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(tableId)
  return { success: true, undo: { method: 'POST', url: `/api/base/tables/${tableId}/restore`, body: {} } }
}

export function restoreTable(tableId) {
  const table = db.prepare('SELECT id FROM base_tables WHERE id = ? AND deleted_at IS NOT NULL').get(tableId)
  if (!table) return null
  db.prepare("UPDATE base_tables SET deleted_at = NULL, updated_at = datetime('now') WHERE id = ?").run(tableId)
  return { ...db.prepare('SELECT * FROM base_tables WHERE id = ?').get(tableId), record_count: recordCount(tableId) }
}

// ── Fields ────────────────────────────────────────────────────────────────────

export function getFields(tableId) {
  if (!ownsTable(tableId)) return null
  return db.prepare(`
    SELECT * FROM base_fields WHERE table_id = ? ORDER BY is_primary DESC, sort_order ASC
  `).all(tableId).map(f => ({ ...f, options: tryParse(f.options) }))
}

function tryParse(s, fallback = {}) {
  try { return JSON.parse(s || '{}') } catch { return fallback }
}

export function createField(tableId, { name, key, type = 'text', options = {}, required = 0, default_value = null, width = 160 }) {
  if (!ownsTable(tableId)) return null

  const fieldKey = uniqueKey(tableId, key || name)

  // Autonumber: only one allowed
  if (type === 'autonumber') {
    const existing = db.prepare("SELECT id FROM base_fields WHERE table_id = ? AND type = 'autonumber' AND deleted_at IS NULL").get(tableId)
    if (existing) throw Object.assign(new Error('Un seul champ autonumber est autorisé par table'), { status: 400 })
  }

  const maxSort = db.prepare('SELECT MAX(sort_order) as m FROM base_fields WHERE table_id = ?').get(tableId).m || 0
  const sortOrder = maxSort + 1
  const fieldId = newId('field')

  if (type === 'link') {
    const linkedTableId = options.linked_table_id
    const linkedTable = db.prepare('SELECT * FROM base_tables WHERE id = ? AND deleted_at IS NULL').get(linkedTableId)
    if (!linkedTable) throw Object.assign(new Error('Table liée introuvable'), { status: 400 })

    const currentTable = db.prepare('SELECT * FROM base_tables WHERE id = ?').get(tableId)
    const inverseFieldId = newId('field')
    const inverseKey = uniqueKey(linkedTableId, slugify(currentTable.name))
    const inverseSort = (db.prepare('SELECT MAX(sort_order) as m FROM base_fields WHERE table_id = ?').get(linkedTableId).m || 0) + 1

    db.transaction(() => {
      db.prepare(`
        INSERT INTO base_fields (id, table_id, name, key, type, options, required, default_value, sort_order, width, is_primary)
        VALUES (?, ?, ?, ?, 'link', ?, ?, ?, ?, ?, 0)
      `).run(fieldId, tableId, name, fieldKey,
        JSON.stringify({ ...options, inverse_field_id: inverseFieldId }),
        required ? 1 : 0, default_value, sortOrder, width)

      db.prepare(`
        INSERT INTO base_fields (id, table_id, name, key, type, options, required, default_value, sort_order, width, is_primary)
        VALUES (?, ?, ?, ?, 'link', ?, 0, NULL, ?, 160, 0)
      `).run(inverseFieldId, linkedTableId, currentTable.name, inverseKey,
        JSON.stringify({ linked_table_id: tableId, inverse_field_id: fieldId, is_inverse: true, allow_multiple: true }),
        inverseSort)
    })()

    const created = { ...db.prepare('SELECT * FROM base_fields WHERE id = ?').get(fieldId), options: tryParse(null) }
    created.options = tryParse(db.prepare('SELECT options FROM base_fields WHERE id = ?').get(fieldId)?.options)
    const inverse = db.prepare('SELECT * FROM base_fields WHERE id = ?').get(inverseFieldId)
    return {
      field: { ...created, options: tryParse(created.options) },
      inverse_field: { ...inverse, options: tryParse(inverse.options) },
      undo: { method: 'DELETE', url: `/api/base/fields/${fieldId}`, body: {} }
    }
  }

  db.prepare(`
    INSERT INTO base_fields (id, table_id, name, key, type, options, required, default_value, sort_order, width, is_primary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(fieldId, tableId, name, fieldKey, type,
    JSON.stringify(options), required ? 1 : 0, default_value, sortOrder, width)

  const field = db.prepare('SELECT * FROM base_fields WHERE id = ?').get(fieldId)
  return { field: { ...field, options: tryParse(field.options) }, undo: { method: 'DELETE', url: `/api/base/fields/${fieldId}`, body: {} } }
}

export function updateField(fieldId, updates) {
  const field = ownsField(fieldId)
  if (!field) return null

  const opts = tryParse(field.options)

  if (field.is_primary) {
    const allowed = ['name', 'width', 'type']
    const badKeys = Object.keys(updates).filter(k => !allowed.includes(k))
    if (badKeys.length) throw Object.assign(new Error(`Champ primaire : seuls name, type et width sont modifiables`), { status: 400 })
    const allowedTypes = ['text', 'number', 'autonumber', 'formula']
    if (updates.type && !allowedTypes.includes(updates.type)) {
      throw Object.assign(new Error('Type invalide pour un champ primaire'), { status: 400 })
    }
  }

  if (opts.is_inverse) {
    const allowed = ['name', 'width']
    const badKeys = Object.keys(updates).filter(k => !allowed.includes(k))
    if (badKeys.length) throw Object.assign(new Error('Champ lien inverse : seuls name et width sont modifiables'), { status: 400 })
  }

  const { name, type, options, required, default_value, width } = updates
  db.prepare(`
    UPDATE base_fields SET
      name = COALESCE(?, name),
      type = COALESCE(?, type),
      options = COALESCE(?, options),
      required = COALESCE(?, required),
      default_value = COALESCE(?, default_value),
      width = COALESCE(?, width),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    name !== undefined ? name : null,
    type !== undefined ? type : null,
    options !== undefined ? JSON.stringify(options) : null,
    required !== undefined ? (required ? 1 : 0) : null,
    default_value !== undefined ? default_value : null,
    width !== undefined ? width : null,
    fieldId
  )

  const updated = db.prepare('SELECT * FROM base_fields WHERE id = ?').get(fieldId)
  return { ...updated, options: tryParse(updated.options) }
}

export function deleteField(fieldId) {
  const field = ownsField(fieldId)
  if (!field) return null
  if (field.is_primary) throw Object.assign(new Error('Le champ primaire ne peut pas être supprimé'), { status: 400 })

  db.transaction(() => {
    db.prepare("UPDATE base_fields SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(fieldId)
    if (field.type === 'link') {
      const opts = tryParse(field.options)
      if (opts.inverse_field_id) {
        db.prepare("UPDATE base_fields SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(opts.inverse_field_id)
      }
    }
  })()

  return { success: true, undo: { method: 'POST', url: `/api/base/fields/${fieldId}/restore`, body: {} } }
}

export function restoreField(fieldId) {
  const field = ownsField(fieldId)
  if (!field || !field.deleted_at) return null

  db.transaction(() => {
    db.prepare("UPDATE base_fields SET deleted_at = NULL, updated_at = datetime('now') WHERE id = ?").run(fieldId)
    if (field.type === 'link') {
      const opts = tryParse(field.options)
      if (opts.inverse_field_id) {
        db.prepare("UPDATE base_fields SET deleted_at = NULL, updated_at = datetime('now') WHERE id = ?").run(opts.inverse_field_id)
      }
    }
  })()

  const updated = db.prepare('SELECT * FROM base_fields WHERE id = ?').get(fieldId)
  return { ...updated, options: tryParse(updated.options) }
}

export function reorderFields(tableId, orders) {
  if (!ownsTable(tableId)) return null
  db.transaction(() => {
    const update = db.prepare('UPDATE base_fields SET sort_order = ? WHERE id = ? AND table_id = ?')
    for (const { id, sort_order } of orders) {
      // Never move primary field away from 0
      const f = db.prepare('SELECT is_primary FROM base_fields WHERE id = ?').get(id)
      if (f?.is_primary) continue
      update.run(sort_order, id, tableId)
    }
  })()
  return { success: true }
}

// ── Records ───────────────────────────────────────────────────────────────────

export function getRecords(tableId, { search, filters, sorts, limit = 50, page = 1, view_id, group_by, group_summaries } = {}) {
  if (!ownsTable(tableId)) return null

  // Load fields for enrichment
  const fields = db.prepare("SELECT * FROM base_fields WHERE table_id = ? ORDER BY is_primary DESC, sort_order ASC").all(tableId)
    .map(f => ({ ...f, options: tryParse(f.options) }))

  // View config defaults
  let viewFilters = null, viewSorts = null, viewGroupBy = null, viewSummaries = null
  if (view_id) {
    const view = db.prepare('SELECT config FROM base_views WHERE id = ? AND deleted_at IS NULL').get(view_id)
    if (view) {
      const cfg = tryParse(view.config)
      if (!filters && cfg.filters?.length) viewFilters = cfg.filters
      if (!sorts && cfg.sorts?.length) viewSorts = cfg.sorts
      if (!group_by && cfg.group_by) viewGroupBy = cfg.group_by
      if (!group_summaries && cfg.group_summaries) viewSummaries = cfg.group_summaries
    }
  }

  // Build base WHERE
  const where = ['r.table_id = ?', 'r.deleted_at IS NULL']
  const params = [tableId]

  // Search on primary field
  if (search) {
    const pf = fields.find(f => f.is_primary)
    if (pf?.key) {
      where.push(`json_extract(r.data, '$.${pf.key}') LIKE ?`)
      params.push(`%${search}%`)
    }
  }

  // Advanced filters
  const activeFilters = filters
    ? (typeof filters === 'string' ? tryParse(filters, null) : filters)
    : viewFilters
  if (activeFilters) {
    const { sql: fSql, params: fParams } = buildFilterSQL(activeFilters)
    if (fSql && fSql !== '1=1') {
      where.push(`(${fSql})`)
      params.push(...fParams)
    }
  }

  // Sorting
  const activeSorts = sorts
    ? (typeof sorts === 'string' ? tryParse(sorts, []) : sorts)
    : (viewSorts || [])
  let orderBy = 'r.sort_order ASC, r.created_at ASC'
  if (activeSorts.length) {
    const sc = activeSorts
      .filter(s => safeKey(s.field_key))
      .map(s => `json_extract(r.data, '$.${s.field_key}') ${s.direction === 'desc' ? 'DESC' : 'ASC'}`)
    if (sc.length) orderBy = sc.join(', ')
  }

  const whereSQL = where.join(' AND ')

  // ── Grouping mode ─────────────────────────────────────────────────────────
  const activeGroupBy = group_by
    ? (typeof group_by === 'string' ? tryParse(group_by, null) : group_by)
    : viewGroupBy
  const activeSummaries = group_summaries
    ? (typeof group_summaries === 'string' ? tryParse(group_summaries, { _count: true }) : group_summaries)
    : (viewSummaries || { _count: true })

  if (activeGroupBy) {
    // Fetch up to 5000 records (no pagination in group mode)
    const rows = db.prepare(`SELECT * FROM base_records r WHERE ${whereSQL} ORDER BY ${orderBy} LIMIT 5000`).all(...params)
    const parsed = rows.map(parseRecord)
    const enriched = enrichRecords(db, parsed, fields)
    return groupRecords(enriched, Array.isArray(activeGroupBy) ? activeGroupBy : [activeGroupBy], activeSummaries, fields)
  }

  // ── Flat mode ─────────────────────────────────────────────────────────────
  const total = db.prepare(`SELECT COUNT(*) as c FROM base_records r WHERE ${whereSQL}`).get(...params).c
  if (limit === 'all') {
    const rows = db.prepare(`SELECT * FROM base_records r WHERE ${whereSQL} ORDER BY ${orderBy}`).all(...params)
    const parsed = rows.map(parseRecord)
    const enriched = enrichRecords(db, parsed, fields)
    return { data: enriched, total, page: 1, limit: total }
  }
  const lim = Math.min(parseInt(limit) || 50, 500)
  const off = (Math.max(parseInt(page), 1) - 1) * lim
  const rows = db.prepare(`SELECT * FROM base_records r WHERE ${whereSQL} ORDER BY ${orderBy} LIMIT ? OFFSET ?`).all(...params, lim, off)
  const parsed = rows.map(parseRecord)
  const enriched = enrichRecords(db, parsed, fields)

  return { data: enriched, total, page: parseInt(page), limit: lim }
}

export function createRecord(tableId, userId, inputData = {}) {
  if (!ownsTable(tableId)) return null

  const recordId = newId('record')
  const maxSort = db.prepare('SELECT MAX(sort_order) as m FROM base_records WHERE table_id = ?').get(tableId).m || 0

  // Find link fields and extract them before storing data
  const linkFields = db.prepare("SELECT * FROM base_fields WHERE table_id = ? AND type = 'link' AND deleted_at IS NULL").all(tableId)
    .map(f => ({ ...f, options: tryParse(f.options) }))

  const data = { ...inputData }
  const linkEntries = []

  for (const lf of linkFields) {
    if (data[lf.key] !== undefined) {
      const targets = Array.isArray(data[lf.key]) ? data[lf.key] : [data[lf.key]]
      linkEntries.push({ field: lf, targets: targets.filter(Boolean) })
      delete data[lf.key]
    }
  }

  // Autonumber
  const autonumField = db.prepare("SELECT * FROM base_fields WHERE table_id = ? AND type = 'autonumber' AND deleted_at IS NULL").get(tableId)

  const run = db.transaction(() => {
    let seq = null
    if (autonumField) {
      db.prepare('UPDATE base_tables SET autonumber_seq = autonumber_seq + 1 WHERE id = ?').run(tableId)
      seq = db.prepare('SELECT autonumber_seq FROM base_tables WHERE id = ?').get(tableId).autonumber_seq
      const af = { ...autonumField, options: tryParse(autonumField.options) }
      data[af.key] = seq
    }

    db.prepare(`
      INSERT INTO base_records (id, table_id, data, sort_order)
      VALUES (?, ?, ?, ?)
    `).run(recordId, tableId, JSON.stringify(data), maxSort + 1)

    // Record links
    for (const { field, targets } of linkEntries) {
      const opts = field.options
      for (const targetId of targets) {
        db.prepare(`INSERT OR IGNORE INTO base_record_links (id, field_id, source_record_id, target_record_id) VALUES (?, ?, ?, ?)`)
          .run(newId('record'), field.id, recordId, targetId)
        if (opts.inverse_field_id) {
          db.prepare(`INSERT OR IGNORE INTO base_record_links (id, field_id, source_record_id, target_record_id) VALUES (?, ?, ?, ?)`)
            .run(newId('record'), opts.inverse_field_id, targetId, recordId)
        }
      }
    }

    // History
    db.prepare(`INSERT INTO record_history (id, table_id, record_id, user_id, action, diff) VALUES (?, ?, ?, ?, 'create', NULL)`)
      .run(newId('record'), tableId, recordId, userId)
  })
  run()

  const record = db.prepare('SELECT * FROM base_records WHERE id = ?').get(recordId)
  const parsed = parseRecord(record)

  // Fire automations
  const tableRow = db.prepare('SELECT * FROM base_tables WHERE id = ?').get(tableId)
  checkAndRunAutomations('record_created', {
    record: { id: recordId, data: parsed.data },
    table: tableRow ? { id: tableRow.id, name: tableRow.name } : { id: tableId },
  })

  return { ...parsed, undo: { method: 'DELETE', url: `/api/base/records/${recordId}`, body: {} } }
}

const READONLY_KEYS = new Set(['autonumber', 'formula', 'rollup', 'lookup', 'created_at', 'updated_at'])

export function updateRecord(recordId, userId, inputData = {}) {
  const record = ownsRecord(recordId)
  if (!record) return null

  const fields = db.prepare("SELECT * FROM base_fields WHERE table_id = ? AND deleted_at IS NULL").all(record.table_id)
    .map(f => ({ ...f, options: tryParse(f.options) }))

  const readonlyKeys = new Set(fields.filter(f => READONLY_KEYS.has(f.type)).map(f => f.key))
  const linkFields = fields.filter(f => f.type === 'link')
  const oldData = tryParse(record.data)

  const newData = { ...oldData }
  const linkEntries = []

  for (const [k, v] of Object.entries(inputData)) {
    if (readonlyKeys.has(k)) continue
    const lf = linkFields.find(f => f.key === k)
    if (lf) {
      const targets = Array.isArray(v) ? v : [v]
      linkEntries.push({ field: lf, targets: targets.filter(Boolean) })
      continue
    }
    newData[k] = v
  }

  // Diff for history
  const changed = []
  for (const [k, v] of Object.entries(inputData)) {
    if (readonlyKeys.has(k)) continue
    if (linkFields.find(f => f.key === k)) continue
    if (JSON.stringify(oldData[k]) !== JSON.stringify(v)) {
      changed.push({ key: k, old: oldData[k], new: v })
    }
  }

  const undoData = {}
  for (const c of changed) undoData[c.key] = c.old

  db.transaction(() => {
    db.prepare(`UPDATE base_records SET data = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(JSON.stringify(newData), recordId)

    for (const { field, targets } of linkEntries) {
      const opts = field.options
      // Remove old links
      db.prepare('DELETE FROM base_record_links WHERE field_id = ? AND source_record_id = ?').run(field.id, recordId)
      if (opts.inverse_field_id) {
        db.prepare('DELETE FROM base_record_links WHERE field_id = ? AND target_record_id = ?').run(opts.inverse_field_id, recordId)
      }
      // Insert new links
      for (const targetId of targets) {
        db.prepare(`INSERT OR IGNORE INTO base_record_links (id, field_id, source_record_id, target_record_id) VALUES (?, ?, ?, ?)`)
          .run(newId('record'), field.id, recordId, targetId)
        if (opts.inverse_field_id) {
          db.prepare(`INSERT OR IGNORE INTO base_record_links (id, field_id, source_record_id, target_record_id) VALUES (?, ?, ?, ?)`)
            .run(newId('record'), opts.inverse_field_id, targetId, recordId)
        }
      }
    }

    // History entries
    for (const c of changed) {
      db.prepare(`INSERT INTO record_history (id, table_id, record_id, user_id, action, diff) VALUES (?, ?, ?, ?, 'update', ?)`)
        .run(newId('record'), record.table_id, recordId, userId,
          JSON.stringify({ field_key: c.key, old_value: c.old, new_value: c.new, source: 'user' }))
    }
  })()

  const updated = db.prepare('SELECT * FROM base_records WHERE id = ?').get(recordId)
  const parsedUpdated = parseRecord(updated)

  // Fire automations for each changed field
  if (changed.length > 0) {
    const tableRow = db.prepare('SELECT * FROM base_tables WHERE id = ?').get(record.table_id)
    const tableData = tableRow ? { id: tableRow.id, name: tableRow.name } : { id: record.table_id }
    for (const c of changed) {
      const base = { record: { id: recordId, data: parsedUpdated.data }, table: tableData, field: { key: c.key }, oldValue: c.old, newValue: c.new }
      checkAndRunAutomations('record_updated', base)
      checkAndRunAutomations('field_changed', base)
    }
  }

  return {
    ...parsedUpdated,
    undo: { method: 'PATCH', url: `/api/base/records/${recordId}`, body: { data: undoData } }
  }
}

export function getRecord(recordId) {
  const record = ownsRecord(recordId)
  if (!record) return null
  const fields = db.prepare("SELECT * FROM base_fields WHERE table_id = ? ORDER BY is_primary DESC, sort_order ASC").all(record.table_id)
    .map(f => ({ ...f, options: tryParse(f.options) }))
  const enriched = enrichRecords([record], fields)[0]
  return { record: { ...enriched, data: tryParse(enriched.data) } }
}

export function deleteRecord(recordId, userId) {
  const record = ownsRecord(recordId)
  if (!record) return null

  db.transaction(() => {
    db.prepare("UPDATE base_records SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(recordId)
    db.prepare(`INSERT INTO record_history (id, table_id, record_id, user_id, action, diff) VALUES (?, ?, ?, ?, 'delete', NULL)`)
      .run(newId('record'), record.table_id, recordId, userId)
  })()

  return { success: true, undo: { method: 'POST', url: `/api/base/records/${recordId}/restore`, body: {} } }
}

export function restoreRecord(recordId, userId) {
  const record = db.prepare(`
    SELECT r.* FROM base_records r
    WHERE r.id = ? AND r.deleted_at IS NOT NULL
  `).get(recordId)
  if (!record) return null

  db.transaction(() => {
    db.prepare("UPDATE base_records SET deleted_at = NULL, updated_at = datetime('now') WHERE id = ?").run(recordId)
    db.prepare(`INSERT INTO record_history (id, table_id, record_id, user_id, action, diff) VALUES (?, ?, ?, ?, 'restore', NULL)`)
      .run(newId('record'), record.table_id, recordId, userId)
  })()

  return parseRecord(db.prepare('SELECT * FROM base_records WHERE id = ?').get(recordId))
}

export function duplicateRecord(recordId, userId) {
  const record = ownsRecord(recordId)
  if (!record) return null

  const oldData = tryParse(record.data)
  const newData = { ...oldData }

  // Clear attachment fields
  const attachFields = db.prepare("SELECT key FROM base_fields WHERE table_id = ? AND type = 'attachment' AND deleted_at IS NULL").all(record.table_id)
  for (const f of attachFields) newData[f.key] = []

  // Handle autonumber
  const autonumField = db.prepare("SELECT key FROM base_fields WHERE table_id = ? AND type = 'autonumber' AND deleted_at IS NULL").get(record.table_id)

  const newRecordId = newId('record')
  const maxSort = db.prepare('SELECT MAX(sort_order) as m FROM base_records WHERE table_id = ?').get(record.table_id).m || 0

  db.transaction(() => {
    if (autonumField) {
      db.prepare('UPDATE base_tables SET autonumber_seq = autonumber_seq + 1 WHERE id = ?').run(record.table_id)
      const seq = db.prepare('SELECT autonumber_seq FROM base_tables WHERE id = ?').get(record.table_id).autonumber_seq
      newData[autonumField.key] = seq
    }
    db.prepare(`INSERT INTO base_records (id, table_id, data, sort_order) VALUES (?, ?, ?, ?)`)
      .run(newRecordId, record.table_id, JSON.stringify(newData), maxSort + 1)
    db.prepare(`INSERT INTO record_history (id, table_id, record_id, user_id, action, diff) VALUES (?, ?, ?, ?, 'create', ?)`)
      .run(newId('record'), record.table_id, newRecordId, userId, JSON.stringify({ source: 'duplicate', from: recordId }))
  })()

  return parseRecord(db.prepare('SELECT * FROM base_records WHERE id = ?').get(newRecordId))
}

export function reorderRecords(tableId, orders) {
  if (!ownsTable(tableId)) return null
  db.transaction(() => {
    const upd = db.prepare('UPDATE base_records SET sort_order = ? WHERE id = ? AND table_id = ?')
    for (const { id, row_order } of orders) upd.run(row_order, id, tableId)
  })()
  return { success: true }
}

export function getRecordHistory(recordId) {
  const record = ownsRecord(recordId)
  if (!record) return null

  const rows = db.prepare(`
    SELECT h.*, u.name as user_name
    FROM record_history h
    LEFT JOIN users u ON h.user_id = u.id
    WHERE h.record_id = ?
    ORDER BY h.created_at DESC
    LIMIT 100
  `).all(recordId)

  return rows.map(r => {
    const diff = tryParse(r.diff, null)
    return {
      id: r.id,
      user: r.user_id ? { id: r.user_id, name: r.user_name } : null,
      action: r.action,
      field_key: diff?.field_key ?? null,
      old_value: diff?.old_value ?? null,
      new_value: diff?.new_value ?? null,
      source: diff?.source ?? 'system',
      changed_at: r.created_at,
    }
  })
}

// ── Views ─────────────────────────────────────────────────────────────────────

export function getViews(tableId) {
  if (!ownsTable(tableId)) return null
  return db.prepare(`
    SELECT * FROM base_views WHERE table_id = ? AND deleted_at IS NULL ORDER BY is_default DESC, sort_order ASC, created_at ASC
  `).all(tableId).map(parseView)
}

export function createView(tableId, { name, visible_fields, field_order, filters = [], sorts = [], group_by = null, group_summaries = {}, frozen_fields_count = 0, type = 'grid' }) {
  if (!ownsTable(tableId)) return null

  // Default visible_fields from the default view if not provided
  let vf = visible_fields
  if (!vf) {
    const defView = db.prepare('SELECT config FROM base_views WHERE table_id = ? AND is_default = 1').get(tableId)
    if (defView) vf = tryParse(defView.config).visible_fields
  }

  const viewId = newId('view')
  const maxSort = db.prepare('SELECT MAX(sort_order) as m FROM base_views WHERE table_id = ?').get(tableId).m || 0

  db.prepare(`
    INSERT INTO base_views (id, table_id, name, type, config, sort_order, is_default)
    VALUES (?, ?, ?, ?, ?, ?, 0)
  `).run(viewId, tableId, name, type,
    JSON.stringify({ visible_fields: vf, field_order: field_order || vf, filters, sorts, group_by, group_summaries, frozen_fields_count }),
    maxSort + 1)

  return parseView(db.prepare('SELECT * FROM base_views WHERE id = ?').get(viewId))
}

export function updateView(viewId, updates) {
  const view = ownsView(viewId)
  if (!view) return null

  const currentConfig = tryParse(view.config)
  const { name, ...configUpdates } = updates
  const newConfig = { ...currentConfig, ...configUpdates }

  db.prepare(`
    UPDATE base_views SET
      name = COALESCE(?, name),
      config = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(name !== undefined ? name : null, JSON.stringify(newConfig), viewId)

  return parseView(db.prepare('SELECT * FROM base_views WHERE id = ?').get(viewId))
}

export function deleteView(viewId) {
  const view = ownsView(viewId)
  if (!view) return null
  if (view.is_default) throw Object.assign(new Error('La vue par défaut ne peut pas être supprimée'), { status: 400 })
  db.prepare("UPDATE base_views SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(viewId)
  return { success: true, undo: { method: 'POST', url: `/api/base/views/${viewId}/restore`, body: {} } }
}

export function duplicateView(viewId) {
  const view = ownsView(viewId)
  if (!view) return null

  const newViewId = newId('view')
  const maxSort = db.prepare('SELECT MAX(sort_order) as m FROM base_views WHERE table_id = ?').get(view.table_id).m || 0

  db.prepare(`
    INSERT INTO base_views (id, table_id, name, type, config, sort_order, is_default)
    VALUES (?, ?, ?, ?, ?, ?, 0)
  `).run(newViewId, view.table_id, `${view.name} (copie)`, view.type, view.config, maxSort + 1)

  return parseView(db.prepare('SELECT * FROM base_views WHERE id = ?').get(newViewId))
}

export function restoreView(viewId) {
  const view = db.prepare(`
    SELECT v.* FROM base_views v
    WHERE v.id = ? AND v.deleted_at IS NOT NULL
  `).get(viewId)
  if (!view) return null
  db.prepare("UPDATE base_views SET deleted_at = NULL, updated_at = datetime('now') WHERE id = ?").run(viewId)
  return parseView(db.prepare('SELECT * FROM base_views WHERE id = ?').get(viewId))
}

// ── Trash ─────────────────────────────────────────────────────────────────────

export function getTrash() {
  const tables = db.prepare(`
    SELECT * FROM base_tables WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC
  `).all()

  const fields = db.prepare(`
    SELECT f.*, t.name as table_name FROM base_fields f
    JOIN base_tables t ON f.table_id = t.id
    WHERE f.deleted_at IS NOT NULL ORDER BY f.deleted_at DESC
  `).all().map(f => ({ ...f, options: tryParse(f.options) }))

  const views = db.prepare(`
    SELECT v.*, t.name as table_name FROM base_views v
    JOIN base_tables t ON v.table_id = t.id
    WHERE v.deleted_at IS NOT NULL ORDER BY v.deleted_at DESC
  `).all().map(parseView)

  return { tables, fields, views }
}

// ── Bulk operations ───────────────────────────────────────────────────────────

export function bulkUpdateRecords(tableId, recordIds, inputData, userId) {
  if (!recordIds?.length) return { updated: 0 }
  if (recordIds.length > 500) throw Object.assign(new Error('Maximum 500 records par appel'), { status: 400 })
  if (!ownsTable(tableId)) return null

  const fields = db.prepare("SELECT * FROM base_fields WHERE table_id = ? AND deleted_at IS NULL").all(tableId)
    .map(f => ({ ...f, options: tryParse(f.options) }))
  const readonlyKeys = new Set(fields.filter(f => READONLY_KEYS.has(f.type)).map(f => f.key))

  const cleanData = Object.fromEntries(Object.entries(inputData).filter(([k]) => !readonlyKeys.has(k)))

  let updated = 0
  db.transaction(() => {
    for (const recordId of recordIds) {
      const record = db.prepare(`
        SELECT r.* FROM base_records r
        WHERE r.id = ? AND r.table_id = ? AND r.deleted_at IS NULL
      `).get(recordId, tableId)
      if (!record) continue

      const oldData = tryParse(record.data)
      const newData = { ...oldData, ...cleanData }

      db.prepare("UPDATE base_records SET data = ?, updated_at = datetime('now') WHERE id = ?")
        .run(JSON.stringify(newData), recordId)

      for (const [k, v] of Object.entries(cleanData)) {
        if (JSON.stringify(oldData[k]) !== JSON.stringify(v)) {
          db.prepare(`INSERT INTO record_history (id, table_id, record_id, user_id, action, diff) VALUES (?, ?, ?, ?, 'update', ?)`)
            .run(newId('record'), tableId, recordId, userId,
              JSON.stringify({ field_key: k, old_value: oldData[k], new_value: v, source: 'user' }))
        }
      }
      updated++
    }
  })()

  return { updated }
}

export function bulkDeleteRecords(tableId, recordIds, userId) {
  if (!recordIds?.length) return { deleted: 0 }
  if (recordIds.length > 500) throw Object.assign(new Error('Maximum 500 records par appel'), { status: 400 })
  if (!ownsTable(tableId)) return null

  let deleted = 0
  db.transaction(() => {
    for (const recordId of recordIds) {
      const record = db.prepare(`
        SELECT r.* FROM base_records r
        WHERE r.id = ? AND r.table_id = ? AND r.deleted_at IS NULL
      `).get(recordId, tableId)
      if (!record) continue

      db.prepare("UPDATE base_records SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(recordId)
      db.prepare(`INSERT INTO record_history (id, table_id, record_id, user_id, action, diff) VALUES (?, ?, ?, ?, 'delete', NULL)`)
        .run(newId('record'), tableId, recordId, userId)
      deleted++
    }
  })()

  return { deleted }
}

export function bulkCreateRecords(tableId, recordsData, userId) {
  if (!recordsData?.length) return { created: 0, records: [] }
  if (recordsData.length > 500) throw Object.assign(new Error('Maximum 500 records par appel'), { status: 400 })
  if (!ownsTable(tableId)) return null

  const maxSort = db.prepare('SELECT MAX(sort_order) as m FROM base_records WHERE table_id = ?').get(tableId).m || 0
  const autonumField = db.prepare("SELECT * FROM base_fields WHERE table_id = ? AND type = 'autonumber' AND deleted_at IS NULL").get(tableId)
  const linkFields = db.prepare("SELECT * FROM base_fields WHERE table_id = ? AND type = 'link' AND deleted_at IS NULL").all(tableId)
    .map(f => ({ ...f, options: tryParse(f.options) }))

  const createdRecords = []

  db.transaction(() => {
    let seq = autonumField
      ? db.prepare('SELECT autonumber_seq FROM base_tables WHERE id = ?').get(tableId).autonumber_seq
      : null

    for (let i = 0; i < recordsData.length; i++) {
      const inputData = recordsData[i].data || {}
      const data = { ...inputData }
      const linkEntries = []

      for (const lf of linkFields) {
        if (data[lf.key] !== undefined) {
          const targets = Array.isArray(data[lf.key]) ? data[lf.key] : [data[lf.key]]
          linkEntries.push({ field: lf, targets: targets.filter(Boolean) })
          delete data[lf.key]
        }
      }

      if (autonumField) {
        seq++
        db.prepare('UPDATE base_tables SET autonumber_seq = ? WHERE id = ?').run(seq, tableId)
        data[autonumField.key] = seq
      }

      const recordId = newId('record')
      db.prepare(`INSERT INTO base_records (id, table_id, data, sort_order) VALUES (?, ?, ?, ?)`)
        .run(recordId, tableId, JSON.stringify(data), maxSort + i + 1)

      for (const { field, targets } of linkEntries) {
        const opts = field.options
        for (const targetId of targets) {
          db.prepare(`INSERT OR IGNORE INTO base_record_links (id, field_id, source_record_id, target_record_id) VALUES (?, ?, ?, ?)`)
            .run(newId('record'), field.id, recordId, targetId)
          if (opts.inverse_field_id) {
            db.prepare(`INSERT OR IGNORE INTO base_record_links (id, field_id, source_record_id, target_record_id) VALUES (?, ?, ?, ?)`)
              .run(newId('record'), opts.inverse_field_id, targetId, recordId)
          }
        }
      }

      db.prepare(`INSERT INTO record_history (id, table_id, record_id, user_id, action, diff) VALUES (?, ?, ?, ?, 'create', NULL)`)
        .run(newId('record'), tableId, recordId, userId)

      createdRecords.push(parseRecord(db.prepare('SELECT * FROM base_records WHERE id = ?').get(recordId)))
    }
  })()

  return { created: createdRecords.length, records: createdRecords }
}

export function purgeTrash() {
  const tables = db.prepare("DELETE FROM base_tables WHERE deleted_at IS NOT NULL").run().changes
  const fields = db.prepare(`
    DELETE FROM base_fields WHERE deleted_at IS NOT NULL
  `).run().changes
  const views = db.prepare(`
    DELETE FROM base_views WHERE deleted_at IS NOT NULL
  `).run().changes
  const records = db.prepare(`
    DELETE FROM base_records WHERE deleted_at IS NOT NULL
  `).run().changes

  return { purged: { tables, fields, views, records } }
}
