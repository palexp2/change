import cron from 'node-cron'
import { runAutomation } from './automationEngine.js'
import db from '../db/database.js'

const scheduledJobs = new Map()

export function initScheduler() {
  const automations = db.prepare(`
    SELECT * FROM automations WHERE trigger_type = 'schedule' AND active = 1 AND deleted_at IS NULL
  `).all()

  for (const automation of automations) {
    scheduleAutomation(automation)
  }
  console.log(`Scheduler: ${automations.length} automation(s) planifiée(s)`)
}

export function scheduleAutomation(automation) {
  if (scheduledJobs.has(automation.id)) {
    scheduledJobs.get(automation.id).stop()
    scheduledJobs.delete(automation.id)
  }

  const config = JSON.parse(automation.trigger_config || '{}')
  const cronExpr = config.cron
  if (!cronExpr || !cron.validate(cronExpr)) return

  const job = cron.schedule(cronExpr, () => {
    runAutomation(automation, { trigger: 'schedule' })
  })

  scheduledJobs.set(automation.id, job)
}

export function unscheduleAutomation(automationId) {
  if (scheduledJobs.has(automationId)) {
    scheduledJobs.get(automationId).stop()
    scheduledJobs.delete(automationId)
  }
}
