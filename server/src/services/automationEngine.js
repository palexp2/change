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
    const sandbox = buildSandbox(triggerData, logs)
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
      UPDATE automations SET last_run_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), last_run_status = 'success', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(automation.id)

    return { status: 'success', output, error: null, duration_ms: duration }

  } catch (err) {
    const duration = Date.now() - startTime
    const errorMsg = err.message || 'Erreur inconnue'

    logRun(automation.id, 'error', triggerData, logs.join('\n') || null, errorMsg, duration)
    db.prepare(`
      UPDATE automations SET last_run_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), last_run_status = 'error', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
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

function buildSandbox(triggerData, logs) {
  return {
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

    // Safe read-only query against native ERP tables (SELECT only)
    query: (sql, params = []) => {
      const trimmed = (sql || '').trim().toUpperCase()
      if (!trimmed.startsWith('SELECT')) throw new Error('query() accepte uniquement les requêtes SELECT')
      return db.prepare(sql).all(...(params || []))
    },

    // Send an email via the connected Google account
    sendEmail: async (to, subject, htmlBody) => {
      await gmailSendEmail(to, subject, htmlBody)
      logs.push(`📧 Email envoyé à ${to} — ${subject}`)
    },

    Date, Math, JSON,
    parseInt, parseFloat, isNaN, Number, String, Boolean, Array, Object,
  }
}
