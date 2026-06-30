import { runAutomation } from './automationEngine.js'
import db from '../db/database.js'
import { logSync } from './syncLog.js'

/**
 * Vérifie et déclenche les automations pour un événement.
 * Exécution en arrière-plan (fire-and-forget).
 *
 * Le dispatch tourne dans un setImmediate : sans trace persistée, un échec de
 * l'orchestration (lock DB sur le SELECT, trigger_config corrompu, throw du
 * moteur) ne laisse qu'un console.error invisible et se répète silencieusement
 * sur chaque record. On le journalise donc dans sync_log (DataTable diagnostics
 * des connecteurs) via logSync.
 */
export function checkAndRunAutomations(triggerType, triggerData) {
  setImmediate(async () => {
    const startTime = Date.now()
    try {
      const automations = db.prepare(`
        SELECT * FROM automations
        WHERE active = 1 AND trigger_type = ? AND deleted_at IS NULL
      `).all(triggerType)

      for (const automation of automations) {
        let config
        try {
          config = JSON.parse(automation.trigger_config || '{}')
        } catch (parseErr) {
          // trigger_config corrompu : on trace l'automation fautive sans
          // interrompre le dispatch des autres.
          logSync('automations', 'webhook', {
            status: 'error',
            error: `[${triggerType}] config invalide (automation ${automation.id}): ${parseErr.message}`,
            durationMs: Date.now() - startTime,
          })
          continue
        }
        if (!matchesTrigger(triggerType, config, triggerData)) continue
        await runAutomation(automation, triggerData)
      }
    } catch (err) {
      console.error('Automation trigger error:', err.message)
      logSync('automations', 'webhook', {
        status: 'error',
        error: `[${triggerType}] dispatch échoué: ${err.message}`,
        durationMs: Date.now() - startTime,
      })
    }
  })
}

function matchesTrigger(triggerType, config, triggerData) {
  switch (triggerType) {
    case 'record_created':
      return !config.table_id || config.table_id === triggerData.table?.id

    case 'record_updated':
      if (config.table_id && config.table_id !== triggerData.table?.id) return false
      if (config.field_key && triggerData.field?.key !== config.field_key) return false
      return true

    case 'field_changed':
      if (config.table_id && config.table_id !== triggerData.table?.id) return false
      if (config.field_key && triggerData.field?.key !== config.field_key) return false
      if (config.target_value !== undefined && config.target_value !== '' &&
          String(triggerData.newValue) !== String(config.target_value)) return false
      return true

    default:
      return true
  }
}
