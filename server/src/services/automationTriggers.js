import { runAutomation } from './automationEngine.js'
import db from '../db/database.js'

/**
 * Vérifie et déclenche les automations pour un événement.
 * Exécution en arrière-plan (fire-and-forget).
 */
export function checkAndRunAutomations(triggerType, triggerData) {
  setImmediate(async () => {
    try {
      const automations = db.prepare(`
        SELECT * FROM automations
        WHERE active = 1 AND trigger_type = ? AND deleted_at IS NULL
      `).all(triggerType)

      for (const automation of automations) {
        const config = JSON.parse(automation.trigger_config || '{}')
        if (!matchesTrigger(triggerType, config, triggerData)) continue
        await runAutomation(automation, triggerData)
      }
    } catch (err) {
      console.error('Automation trigger error:', err.message)
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
