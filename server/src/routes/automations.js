import { Router } from 'express'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { newId } from '../utils/ids.js'
import { runAutomation } from '../services/automationEngine.js'
import { scheduleAutomation, unscheduleAutomation } from '../services/automationScheduler.js'
import { MANUAL_RUNNERS, logSystemRun } from '../services/systemAutomations.js'
import { sendInstallationTestEmail, buildInstallationEmailHtml, selectEligibleCompanies } from '../services/installationFollowup.js'
import { dryRunFieldRule } from '../services/fieldRuleEngine.js'
import { getAutomationFrom, listFromAddresses } from '../services/postmarkConfig.js'

const IDENT_RE = /^[a-z_][a-z0-9_]*$/i
const VALID_ACTION_TYPES = new Set(['slack', 'email', 'task', 'script'])
const VALID_OPS = new Set(['eq', 'ne', 'in', 'not_null'])

// Admin-facing field rule validation. Throws on first error.
function validateFieldRule({ trigger_config, action_type, action_config }) {
  const tc = typeof trigger_config === 'string' ? JSON.parse(trigger_config) : trigger_config
  if (!tc || typeof tc !== 'object') throw new Error('trigger_config invalide')
  if (!IDENT_RE.test(tc.erp_table || '')) throw new Error('trigger_config.erp_table invalide')
  if (!IDENT_RE.test(tc.column || '')) throw new Error('trigger_config.column invalide')
  const op = tc.op || 'eq'
  if (!VALID_OPS.has(op)) throw new Error(`trigger_config.op invalide: ${op}`)
  if (op !== 'not_null' && tc.value === undefined) throw new Error('trigger_config.value requise')
  const at = action_type || 'slack'
  if (!VALID_ACTION_TYPES.has(at)) throw new Error(`action_type invalide: ${at}`)
  const ac = typeof action_config === 'string' ? JSON.parse(action_config) : (action_config || {})
  // Anti-cycle: interdire une règle tâche qui écrirait dans la même table que le trigger
  if (at === 'task' && ac.link_company === false && tc.erp_table === 'tasks') {
    throw new Error('Garde anti-cycle: règle sur `tasks` avec action task interdite')
  }
  return { tc, ac, at }
}

// Per-system-automation test-email senders. A registered automation id can be
// previewed in an admin's inbox via POST /api/automations/:id/test-email.
const TEST_EMAIL_SENDERS = {
  sys_installation_followup: (opts) => sendInstallationTestEmail(db, { fromAddress: getAutomationFrom('sys_installation_followup'), ...opts }),
}

// System automations that send email and therefore accept a `from` override in
// action_config. Other system automations remain fully read-only.
const SYSTEM_EMAIL_AUTOMATIONS = new Set([
  'sys_installation_followup',
  'sys_shipment_tracking_email',
])

const router = Router()
router.use(requireAuth)

// GET /api/automations
router.get('/', (req, res) => {
  const automations = db.prepare(`
    SELECT a.*, COALESCE(r.runs_30d, 0) AS runs_30d
    FROM automations a
    LEFT JOIN (
      SELECT automation_id, COUNT(*) AS runs_30d
      FROM automation_logs
      WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')
      GROUP BY automation_id
    ) r ON r.automation_id = a.id
    WHERE a.deleted_at IS NULL
    ORDER BY a.created_at DESC
  `).all()
  res.json(automations)
})

// GET /api/automations/:id
router.get('/:id', (req, res) => {
  const automation = db.prepare(
    'SELECT * FROM automations WHERE id = ? AND deleted_at IS NULL'
  ).get(req.params.id)
  if (!automation) return res.status(404).json({ error: 'Introuvable' })
  res.json(automation)
})

// POST /api/automations
router.post('/', (req, res) => {
  const { name, description, trigger_type, trigger_config, script, active, kind, action_type, action_config } = req.body
  if (!name?.trim()) return res.status(400).json({ error: 'Nom requis' })
  if (!trigger_type && kind !== 'field_rule') return res.status(400).json({ error: 'trigger_type requis' })

  const isFieldRule = kind === 'field_rule'
  let at = 'script', acJson = '{}', tcJson = trigger_config || '{}', tt = trigger_type
  if (isFieldRule) {
    try {
      validateFieldRule({ trigger_config, action_type, action_config })
    } catch (e) { return res.status(400).json({ error: e.message }) }
    at = action_type
    acJson = typeof action_config === 'string' ? action_config : JSON.stringify(action_config || {})
    tcJson = typeof trigger_config === 'string' ? trigger_config : JSON.stringify(trigger_config || {})
    tt = 'field_rule'
  }

  const id = newId('auto')
  db.prepare(`
    INSERT INTO automations (id, name, description, trigger_type, trigger_config, action_type, action_config, script, active, kind)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name.trim(), description || null, tt,
    tcJson, at, acJson, isFieldRule ? '' : (script || ''),
    active !== undefined ? active : 1, isFieldRule ? 'field_rule' : null)

  const created = db.prepare('SELECT * FROM automations WHERE id = ?').get(id)

  if (created.trigger_type === 'schedule' && created.active) {
    scheduleAutomation(created)
  }

  res.status(201).json(created)
})

// PATCH /api/automations/:id
router.patch('/:id', (req, res) => {
  const automation = db.prepare(
    'SELECT * FROM automations WHERE id = ? AND deleted_at IS NULL'
  ).get(req.params.id)
  if (!automation) return res.status(404).json({ error: 'Introuvable' })

  const { name, description, trigger_type, trigger_config, script, active, action_type, action_config } = req.body

  // System scripted automations are read-only except for the `active` toggle
  // and — for email-sending ones — a `from` override in action_config.
  // System field-rules are editable on trigger_config/action_type/action_config
  // (their whole point is a declarative, UI-tunable template) — only name,
  // description, and kind stay locked, plus they can't be deleted.
  if (automation.system && automation.kind !== 'field_rule') {
    const hasActionConfigUpdate = action_config !== undefined
    if (active === undefined && !hasActionConfigUpdate) {
      return res.status(403).json({ error: 'Automation système — lecture seule (seul le statut peut être modifié)' })
    }
    let nextActionConfigJson = null
    if (hasActionConfigUpdate) {
      if (!SYSTEM_EMAIL_AUTOMATIONS.has(automation.id)) {
        return res.status(403).json({ error: 'Automation système — action_config non modifiable' })
      }
      const incoming = typeof action_config === 'string' ? JSON.parse(action_config) : (action_config || {})
      // Only `from` is honored — any other key is silently ignored to avoid
      // surprise changes to system behaviour.
      const current = (() => { try { return JSON.parse(automation.action_config || '{}') } catch { return {} } })()
      const merged = { ...current }
      if ('from' in incoming) {
        const from = incoming.from
        if (from == null || from === '') {
          delete merged.from
        } else {
          const allowed = listFromAddresses()
          if (!allowed.includes(from)) {
            return res.status(400).json({ error: `Adresse "${from}" non autorisée` })
          }
          merged.from = from
        }
      }
      nextActionConfigJson = JSON.stringify(merged)
    }
    db.prepare(`
      UPDATE automations SET
        active = COALESCE(?, active),
        action_config = COALESCE(?, action_config),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(active ?? null, nextActionConfigJson, req.params.id)
    const updated = db.prepare('SELECT * FROM automations WHERE id = ?').get(req.params.id)
    return res.json(updated)
  }

  // Field-rule edits: validate trigger_config/action_config if any of them changed
  if (automation.kind === 'field_rule'
      && (trigger_config !== undefined || action_config !== undefined || action_type !== undefined)) {
    try {
      validateFieldRule({
        trigger_config: trigger_config ?? automation.trigger_config,
        action_type: action_type ?? automation.action_type,
        action_config: action_config ?? automation.action_config,
      })
    } catch (e) { return res.status(400).json({ error: e.message }) }
  }

  db.prepare(`
    UPDATE automations SET
      name = COALESCE(?, name),
      description = COALESCE(?, description),
      trigger_type = COALESCE(?, trigger_type),
      trigger_config = COALESCE(?, trigger_config),
      action_type = COALESCE(?, action_type),
      action_config = COALESCE(?, action_config),
      script = COALESCE(?, script),
      active = COALESCE(?, active),
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(
    automation.system ? null : (name !== undefined ? name.trim() : null),
    automation.system ? null : (description !== undefined ? description : null),
    trigger_type !== undefined ? trigger_type : null,
    trigger_config !== undefined
      ? (typeof trigger_config === 'string' ? trigger_config : JSON.stringify(trigger_config))
      : null,
    action_type !== undefined ? action_type : null,
    action_config !== undefined
      ? (typeof action_config === 'string' ? action_config : JSON.stringify(action_config))
      : null,
    script !== undefined ? script : null,
    active !== undefined ? active : null,
    req.params.id
  )

  const updated = db.prepare('SELECT * FROM automations WHERE id = ?').get(req.params.id)

  // Mettre à jour le scheduler
  if (updated.trigger_type === 'schedule') {
    if (updated.active) scheduleAutomation(updated)
    else unscheduleAutomation(updated.id)
  } else {
    unscheduleAutomation(updated.id)
  }

  res.json(updated)
})

// DELETE /api/automations/:id
router.delete('/:id', (req, res) => {
  const automation = db.prepare(
    'SELECT id, system FROM automations WHERE id = ? AND deleted_at IS NULL'
  ).get(req.params.id)
  if (!automation) return res.status(404).json({ error: 'Introuvable' })
  if (automation.system) {
    return res.status(403).json({ error: 'Automation système — suppression interdite' })
  }

  db.prepare("UPDATE automations SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(req.params.id)
  unscheduleAutomation(req.params.id)
  res.json({ success: true })
})

// GET /api/automations/:id/logs
router.get('/:id/logs', (req, res) => {
  const automation = db.prepare(
    'SELECT id FROM automations WHERE id = ? AND deleted_at IS NULL'
  ).get(req.params.id)
  if (!automation) return res.status(404).json({ error: 'Introuvable' })

  const logs = db.prepare(`
    SELECT * FROM automation_logs WHERE automation_id = ? ORDER BY created_at DESC LIMIT 50
  `).all(req.params.id)
  res.json(logs)
})

// POST /api/automations/:id/run
// Body: { dryRun?: boolean } — only honoured for system automations with a registered manual runner.
router.post('/:id/run', async (req, res) => {
  const automation = db.prepare(
    'SELECT * FROM automations WHERE id = ? AND deleted_at IS NULL'
  ).get(req.params.id)
  if (!automation) return res.status(404).json({ error: 'Introuvable' })

  if (automation.system) {
    const runner = MANUAL_RUNNERS[automation.id]
    if (!runner) {
      return res.status(403).json({ error: 'Automation système — non exécutable manuellement' })
    }
    const dryRun = !!req.body?.dryRun
    const t0 = Date.now()
    try {
      const out = await runner({ dryRun })
      const duration_ms = Date.now() - t0
      // Dry-runs don't pollute the run history — they're previews, not executions.
      if (!dryRun) {
        logSystemRun(automation.id, {
          status: 'success',
          result: `[Manuel] ${out.summary}\n\n${(out.details || []).map(d => `${d.action.toUpperCase()} — ${d.company_name || d.company_id} → ${d.to || '—'}${d.error ? ` · ${d.error}` : ''}`).join('\n')}`,
          duration_ms,
          triggerData: { trigger: 'manual', dryRun: false },
        })
      }
      return res.json({ status: 'success', dryRun, duration_ms, output: out })
    } catch (e) {
      const duration_ms = Date.now() - t0
      if (!dryRun) {
        logSystemRun(automation.id, { status: 'error', error: e.message, duration_ms })
      }
      return res.status(500).json({ status: 'error', error: e.message })
    }
  }

  const result = await runAutomation(automation, { trigger: 'manual' })
  res.json(result)
})

// GET /api/automations/:id/fires?limit=100
router.get('/:id/fires', (req, res) => {
  const automation = db.prepare(
    'SELECT id, kind FROM automations WHERE id = ? AND deleted_at IS NULL'
  ).get(req.params.id)
  if (!automation) return res.status(404).json({ error: 'Introuvable' })
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500)
  const fires = db.prepare(`
    SELECT automation_id, record_table, record_id, fired_at
    FROM automation_rule_fires
    WHERE automation_id = ?
    ORDER BY fired_at DESC
    LIMIT ?
  `).all(req.params.id, limit)
  res.json(fires)
})

// POST /api/automations/:id/reset-fires — re-enable a rule to fire again on existing rows
router.post('/:id/reset-fires', (req, res) => {
  const automation = db.prepare(
    'SELECT id, kind FROM automations WHERE id = ? AND deleted_at IS NULL'
  ).get(req.params.id)
  if (!automation) return res.status(404).json({ error: 'Introuvable' })
  if (automation.kind !== 'field_rule') {
    return res.status(400).json({ error: 'Reset disponible uniquement pour les règles de champ' })
  }
  const info = db.prepare('DELETE FROM automation_rule_fires WHERE automation_id = ?').run(req.params.id)
  res.json({ success: true, deleted: info.changes })
})

// POST /api/automations/:id/test — dry-run a field rule, no dispatch, no fires insertion
router.post('/:id/test', (req, res) => {
  const automation = db.prepare(
    'SELECT * FROM automations WHERE id = ? AND deleted_at IS NULL'
  ).get(req.params.id)
  if (!automation) return res.status(404).json({ error: 'Introuvable' })
  if (automation.kind !== 'field_rule') {
    return res.status(400).json({ error: 'Test disponible uniquement pour les règles de champ' })
  }
  try {
    const rule = {
      id: automation.id,
      trigger_config: JSON.parse(automation.trigger_config || '{}'),
      action_type: automation.action_type,
      action_config: JSON.parse(automation.action_config || '{}'),
    }
    const out = dryRunFieldRule(rule)
    res.json(out)
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// GET /api/automations/field-defs?erp_table=tickets
// Returns columns available for field-rule templating (native + airtable_field_defs)
router.get('/field-defs', (req, res) => {
  const erpTable = req.query.erp_table
  if (!erpTable || !IDENT_RE.test(erpTable)) {
    return res.status(400).json({ error: 'erp_table invalide' })
  }
  let native
  try {
    native = db.prepare(`PRAGMA table_info(${erpTable})`).all()
  } catch {
    return res.status(400).json({ error: `Table inconnue: ${erpTable}` })
  }
  if (!native.length) return res.status(400).json({ error: `Table inconnue: ${erpTable}` })
  const defs = db.prepare(
    `SELECT column_name, airtable_field_name, field_type
     FROM airtable_field_defs WHERE erp_table = ? ORDER BY column_name`
  ).all(erpTable)
  const nativeNames = new Set(native.map(c => c.name))
  const defColumns = new Set(defs.map(d => d.column_name))
  // Native columns that have no airtable_field_defs row (id, created_at, etc.)
  const nativeOnly = native
    .filter(c => !defColumns.has(c.name))
    .map(c => ({ column_name: c.name, airtable_field_name: null, field_type: c.type?.toLowerCase() || 'text' }))
  res.json({ columns: [...defs, ...nativeOnly], native_names: [...nativeNames] })
})

// GET /api/automations/field-rule/tables — list of erp_tables that have rules or field defs
router.get('/field-rule/tables', (req, res) => {
  const rows = db.prepare(
    `SELECT DISTINCT erp_table FROM airtable_field_defs ORDER BY erp_table`
  ).all()
  res.json(rows.map(r => r.erp_table))
})

// GET /api/automations/:id/email-preview?language=French
// Renders a sample of the email body for preview in the UI.
// Handles field-rule emails (first dry-run candidate) and sys_installation_followup.
router.get('/:id/email-preview', (req, res) => {
  const automation = db.prepare(
    'SELECT * FROM automations WHERE id = ? AND deleted_at IS NULL'
  ).get(req.params.id)
  if (!automation) return res.status(404).json({ error: 'Introuvable' })

  const language = req.query.language === 'English' ? 'English' : 'French'
  const appUrl = (process.env.APP_URL || 'https://customer.orisha.io').replace(/\/$/, '')

  // System email automations — render template with a real candidate record
  // when one exists, otherwise fall back to hardcoded sample data.
  if (automation.id === 'sys_installation_followup') {
    const subject = language === 'French' ? "Comment s'est passé l'installation ?" : 'How did the installation go?'
    // Relaxed query: ignore the 21-day min and the idempotency flag so that
    // even after a campaign has rolled out, the preview still shows a real row.
    const eligibles = selectEligibleCompanies(db, {
      minDays: 0,
      earliestShipment: '1970-01-01',
      includeAlreadySent: true,
    })
    const candidate = eligibles.find(c =>
      (language === 'French' ? (c.contact_language || c.company_language || '').toLowerCase().startsWith('fr') : true)
    ) || eligibles[0] || null

    const firstName = candidate?.contact_first_name || 'Alex'
    const companyId = candidate?.company_id || '00000000-0000-0000-0000-000000000000'
    const bodyHtml = buildInstallationEmailHtml({
      language,
      firstName,
      companyId,
      emailId: 'preview-sample',
      appUrl,
    })
    return res.json({
      available: true, kind: 'system', automation_id: automation.id,
      subject, bodyHtml, bodyText: null,
      sample: true, languages: ['French', 'English'], language,
      sample_record: candidate
        ? { id: candidate.company_id, label: candidate.company_name }
        : null,
    })
  }

  if (automation.id === 'sys_shipment_tracking_email') {
    return res.json({
      available: false,
      reason: "L'aperçu de cette automation n'est pas encore implémenté — utilisez le bouton « Envoyer le suivi » d'un envoi pour tester.",
    })
  }

  // Field-rule email automations — dry-run first candidate
  if (automation.kind === 'field_rule' && automation.action_type === 'email') {
    let actionConfig = {}
    try { actionConfig = JSON.parse(automation.action_config || '{}') } catch {}
    try {
      const rule = {
        id: automation.id,
        trigger_config: JSON.parse(automation.trigger_config || '{}'),
        action_type: 'email',
        action_config: actionConfig,
      }
      const out = dryRunFieldRule(rule, { previewLimit: 1 })
      const first = out.previews.find(p => !p.error && p.rendered)
      if (first) {
        return res.json({
          available: true, kind: 'field_rule', automation_id: automation.id,
          subject: first.rendered.subject || '',
          bodyHtml: first.rendered.bodyHtml || '',
          bodyText: first.rendered.bodyText || '',
          from: first.rendered.from || null,
          to: first.rendered.to || null,
          sample: true,
          sample_record: { id: first.id, label: first.label },
          candidates_total: out.candidates_total,
        })
      }
      // No candidate matches — return the raw template (placeholders intact)
      return res.json({
        available: true, kind: 'field_rule', automation_id: automation.id,
        subject: actionConfig.subject || '',
        bodyHtml: actionConfig.bodyHtml || '',
        bodyText: actionConfig.bodyText || '',
        from: actionConfig.from || null,
        to: actionConfig.to || null,
        sample: false,
        candidates_total: 0,
      })
    } catch (e) {
      return res.status(400).json({ error: e.message, available: false })
    }
  }

  res.json({ available: false, reason: 'Cette automation n\'envoie pas de courriel ou son aperçu n\'est pas supporté.' })
})

// POST /api/automations/:id/test-email
// Body: { to: string, language?: 'French'|'English' }
router.post('/:id/test-email', async (req, res) => {
  const automation = db.prepare(
    'SELECT id, system FROM automations WHERE id = ? AND deleted_at IS NULL'
  ).get(req.params.id)
  if (!automation) return res.status(404).json({ error: 'Introuvable' })
  const sender = TEST_EMAIL_SENDERS[automation.id]
  if (!sender) return res.status(403).json({ error: 'Pas d\'aperçu disponible pour cette automation' })

  const { to, language } = req.body || {}
  if (!to || !/@/.test(to)) return res.status(400).json({ error: 'Adresse email invalide' })

  try {
    const out = await sender({ to, language })
    res.json({ status: 'success', ...out })
  } catch (e) {
    res.status(500).json({ status: 'error', error: e.message })
  }
})

export default router
