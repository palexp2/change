import { newId } from '../utils/ids.js'
import db from '../db/database.js'
import { runScriptSandboxed } from './scriptSandbox.js'

/**
 * Exécute le script d'une automation.
 *
 * Legacy trigger_type automations restent en lecture seule (pas de `update`) —
 * seules les règles `field_rule` de type `script` reçoivent l'écriture DB.
 */
export async function runAutomation(automation, triggerData = {}) {
  const startTime = Date.now()

  try {
    const { output } = await runScriptSandboxed(automation.script || '', {
      trigger: triggerData,
      enableWrite: false,
    })

    const duration = Date.now() - startTime

    logRun(automation.id, 'success', triggerData, output, null, duration)
    db.prepare(`
      UPDATE automations SET last_run_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), last_run_status = 'success', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(automation.id)

    return { status: 'success', output, error: null, duration_ms: duration }

  } catch (err) {
    const duration = Date.now() - startTime
    const errorMsg = err.message || 'Erreur inconnue'

    const partial = err.partialOutput || null
    logRun(automation.id, 'error', triggerData, partial, errorMsg, duration)
    db.prepare(`
      UPDATE automations SET last_run_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), last_run_status = 'error', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(automation.id)

    return { status: 'error', output: partial, error: errorMsg, duration_ms: duration }
  }
}

function logRun(automationId, status, triggerData, output, error, duration) {
  db.prepare(`
    INSERT INTO automation_logs (id, automation_id, status, trigger_data, result, error, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(newId('log'), automationId, status, JSON.stringify(triggerData), output, error, duration)
}

