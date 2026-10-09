import cron from 'node-cron'
import { runAutomation } from './automationEngine.js'
import { evaluateDateOffsetRules, drainDeferredCandidates } from './fieldRuleEngine.js'
import db from '../db/database.js'
import { runSteps, stepsLog } from './ruleActions/steps.js'
import { logRuleRun } from './systemAutomations.js'
import { APP_URL } from '../config/appUrl.js'

const scheduledJobs = new Map()

// Daily scan of date-relative field rules (« N jours avant/après un champ date »).
// Default 08:00 server time; override with DATE_RULE_CRON. A single job covers
// every date_offset rule across all tables (dedup via automation_rule_fires).
let dateRuleJob = null

// Drains the field-rule backpressure queue (automation_deferred_candidates): one
// CANDIDATE_CAP batch per automation per tick, so rules matching thousands of rows
// fire steadily without waiting for the trigger field to change. Default every
// 2 min; override with FIELD_RULE_DRAIN_CRON.
let deferredDrainJob = null

export function initScheduler() {
  const automations = db.prepare(`
    SELECT * FROM automations WHERE trigger_type = 'schedule' AND active = 1 AND deleted_at IS NULL
  `).all()

  for (const automation of automations) {
    scheduleAutomation(automation)
  }
  console.log(`Scheduler: ${automations.length} automation(s) planifiée(s)`)

  const dateCron = process.env.DATE_RULE_CRON || '0 8 * * *'
  if (cron.validate(dateCron)) {
    if (dateRuleJob) dateRuleJob.stop()
    dateRuleJob = cron.schedule(dateCron, () => {
      evaluateDateOffsetRules()
        .then(r => { if (r?.fired) console.log(`Date rules: ${r.fired} tir(s) sur ${r.rules} règle(s)`) })
        .catch(e => console.error('Date rules scan error:', e))
    })
    console.log(`Scheduler: scan des règles de date planifié (${dateCron})`)
  }

  const drainCron = process.env.FIELD_RULE_DRAIN_CRON || '*/2 * * * *'
  if (cron.validate(drainCron)) {
    if (deferredDrainJob) deferredDrainJob.stop()
    deferredDrainJob = cron.schedule(drainCron, () => {
      drainDeferredCandidates()
        .then(r => { if (r?.fired) console.log(`Field-rule drain: ${r.fired} tir(s) sur ${r.automations} règle(s)`) })
        .catch(e => console.error('Field-rule drain error:', e))
    })
    console.log(`Scheduler: drain des candidats différés planifié (${drainCron})`)
  }
}

export function scheduleAutomation(automation) {
  if (scheduledJobs.has(automation.id)) {
    scheduledJobs.get(automation.id).stop()
    scheduledJobs.delete(automation.id)
  }

  const config = JSON.parse(automation.trigger_config || '{}')
  const cronExpr = config.cron
  if (!cronExpr || !cron.validate(cronExpr)) return

  // Automatisation en blocs planifiée : ses actions, sans enregistrement déclencheur.
  const job = automation.action_type === 'steps'
    ? cron.schedule(cronExpr, () => { runFlowNow(automation.id).catch(() => {}) }, { timezone: 'America/Toronto' })
    : cron.schedule(cronExpr, () => {
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

/** Exécute maintenant une automatisation en blocs planifiée (cron ou « Tester »). */
export async function runFlowNow(automationId, { trigger = 'schedule' } = {}) {
  const a = db.prepare("SELECT * FROM automations WHERE id = ? AND deleted_at IS NULL").get(automationId)
  if (!a || a.action_type !== 'steps') throw new Error('Automatisation introuvable')
  const rule = { id: a.id, name: a.name, trigger_config: JSON.parse(a.trigger_config || '{}'), action_config: JSON.parse(a.action_config || '{}') }
  const started = Date.now()
  try {
    const outputs = await runSteps({ rule, row: { app_url: APP_URL } })
    logRuleRun(a.id, { status: 'success', result: stepsLog(outputs), duration_ms: Date.now() - started, triggerData: { trigger } })
    return { ok: true, outputs }
  } catch (e) {
    logRuleRun(a.id, { status: 'error', error: e.message, duration_ms: Date.now() - started, triggerData: { trigger } })
    throw e
  }
}
