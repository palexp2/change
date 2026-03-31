import { createContext, runInNewContext } from 'node:vm'
import { newId } from '../utils/ids.js'
import db from '../db/database.js'
import { sendEmail as gmailSendEmail } from './gmail.js'

/**
 * Exécute le script d'une automation.
 */
export async function runAutomation(automation, triggerData = {}) {
  const startTime = Date.now()
  const logs = []

  try {
    const sandbox = buildSandbox(automation.tenant_id, triggerData, logs)
    const context = createContext(sandbox)

    await runInNewContext(
      `(async () => { ${automation.script || ''} })()`,
      context,
      { timeout: 10000 }
    )

    const duration = Date.now() - startTime
    const output = logs.join('\n') || null

    logRun(automation.id, 'success', triggerData, output, null, duration)
    db.prepare(`
      UPDATE automations SET last_run_at = datetime('now'), last_run_status = 'success', updated_at = datetime('now')
      WHERE id = ?
    `).run(automation.id)

    return { status: 'success', output, error: null, duration_ms: duration }

  } catch (err) {
    const duration = Date.now() - startTime
    const errorMsg = err.message || 'Erreur inconnue'

    logRun(automation.id, 'error', triggerData, logs.join('\n') || null, errorMsg, duration)
    db.prepare(`
      UPDATE automations SET last_run_at = datetime('now'), last_run_status = 'error', updated_at = datetime('now')
      WHERE id = ?
    `).run(automation.id)

    return { status: 'error', output: logs.join('\n') || null, error: errorMsg, duration_ms: duration }
  }
}

function logRun(automationId, status, triggerData, output, error, duration) {
  db.prepare(`
    INSERT INTO automation_logs (id, automation_id, status, trigger_data, result, error, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(newId('log'), automationId, status, JSON.stringify(triggerData), output, error, duration)
}

function buildSandbox(tenantId, triggerData, logs) {
  return {
    record: triggerData.record || null,
    table: triggerData.table || null,
    field: triggerData.field || null,
    oldValue: triggerData.oldValue ?? null,
    newValue: triggerData.newValue ?? null,

    updateRecord: (recordId, data) => {
      const row = db.prepare('SELECT * FROM base_records WHERE id = ? AND tenant_id = ?').get(recordId, tenantId)
      if (!row) throw new Error(`Record ${recordId} introuvable`)
      const existing = JSON.parse(row.data)
      const merged = { ...existing, ...data }
      db.prepare("UPDATE base_records SET data = ?, updated_at = datetime('now') WHERE id = ?")
        .run(JSON.stringify(merged), recordId)
      for (const [key, val] of Object.entries(data)) {
        if (JSON.stringify(existing[key]) !== JSON.stringify(val)) {
          db.prepare(`
            INSERT INTO record_history (id, tenant_id, table_id, record_id, action, diff)
            VALUES (?, ?, ?, ?, 'update', ?)
          `).run(newId('record'), tenantId, row.table_id, recordId,
            JSON.stringify({ field_key: key, old_value: existing[key], new_value: val, source: 'automation' }))
        }
      }
      return merged
    },

    createRecord: (tableId, data) => {
      const id = newId('record')
      const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM base_records WHERE table_id = ?').get(tableId)
      db.prepare(`
        INSERT INTO base_records (id, tenant_id, table_id, data, sort_order)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, tenantId, tableId, JSON.stringify(data), (maxOrder?.m || 0) + 1)
      db.prepare(`
        INSERT INTO record_history (id, tenant_id, table_id, record_id, action, diff)
        VALUES (?, ?, ?, ?, 'create', ?)
      `).run(newId('record'), tenantId, tableId, id, JSON.stringify({ source: 'automation' }))
      return { id, data }
    },

    deleteRecord: (recordId) => {
      db.prepare("UPDATE base_records SET deleted_at = datetime('now') WHERE id = ? AND tenant_id = ?")
        .run(recordId, tenantId)
    },

    getRecords: (tableId, filters = {}) => {
      let query = 'SELECT * FROM base_records WHERE table_id = ? AND tenant_id = ? AND deleted_at IS NULL'
      const params = [tableId, tenantId]
      if (filters.where) {
        for (const [key, val] of Object.entries(filters.where)) {
          query += ` AND json_extract(data, '$.${key}') = ?`
          params.push(val)
        }
      }
      query += ' LIMIT 500'
      return db.prepare(query).all(...params).map(r => ({ ...r, data: JSON.parse(r.data) }))
    },

    getRecord: (recordId) => {
      const r = db.prepare('SELECT * FROM base_records WHERE id = ? AND tenant_id = ?').get(recordId, tenantId)
      return r ? { ...r, data: JSON.parse(r.data) } : null
    },

    log: (...args) => {
      logs.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '))
    },
    console: {
      log: (...args) => {
        logs.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '))
      }
    },

    fetch: async (url, options = {}) => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 8000)
      try {
        const res = await globalThis.fetch(url, { ...options, signal: controller.signal })
        clearTimeout(timeout)
        const text = await res.text()
        let json
        try { json = JSON.parse(text) } catch { json = null }
        return { ok: res.ok, status: res.status, text, json }
      } catch (err) {
        clearTimeout(timeout)
        throw new Error(`Fetch failed: ${err.message}`)
      }
    },

    // Expose the current tenant ID to scripts
    tenantId,

    // Safe read-only query against native ERP tables (SELECT only)
    query: (sql, params = []) => {
      const trimmed = (sql || '').trim().toUpperCase()
      if (!trimmed.startsWith('SELECT')) throw new Error('query() accepte uniquement les requêtes SELECT')
      return db.prepare(sql).all(...(params || []))
    },

    // Send an email via the tenant's connected Google account
    sendEmail: async (to, subject, htmlBody) => {
      await gmailSendEmail(tenantId, to, subject, htmlBody)
      logs.push(`📧 Email envoyé à ${to} — ${subject}`)
    },

    Date, Math, JSON,
    parseInt, parseFloat, isNaN, Number, String, Boolean, Array, Object,
  }
}
