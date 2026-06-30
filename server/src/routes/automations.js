import { Router } from 'express'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { newId } from '../utils/ids.js'
import { runAutomation } from '../services/automationEngine.js'
import { scheduleAutomation, unscheduleAutomation } from '../services/automationScheduler.js'
import { MANUAL_RUNNERS, logSystemRun } from '../services/systemAutomations.js'
import { sendInstallationTestEmail, buildInstallationEmailHtml, selectEligibleCompanies } from '../services/installationFollowup.js'
import { dryRunFieldRule, runDateOffsetRuleNow, previewRuleForRecord, drainDeferredForAutomation, CANDIDATE_CAP } from '../services/fieldRuleEngine.js'
import { getAutomationFrom, listFromAddresses } from '../services/postmarkConfig.js'
import { processRetryQueue } from '../services/airtableWebhooks.js'
import { generateShortToken } from '../utils/shortToken.js'
import { runWebhook } from '../services/webhookEngine.js'

const IDENT_RE = /^[a-z_][a-z0-9_]*$/i
const VALID_ACTION_TYPES = new Set(['slack', 'email', 'task', 'script'])
// Webhook automations (kind='webhook') — surface déclarative validée côté serveur.
const WEBHOOK_TABLES = new Set(['tickets', 'projects', 'serial_numbers'])
const VALID_STEP_TYPES = new Set(['update', 'upsert', 'create'])
const VALID_VALUE_SOURCES = new Set(['literal', 'param', 'record'])

// Génère un token de webhook compact et non devinable (ex: hookB4FEHK9JYD4S4B).
function newWebhookToken() {
  return 'hook' + generateShortToken(14)
}

// Valide la config d'un webhook. Lève sur la première erreur.
function validateWebhook({ action_config, script }) {
  const ac = typeof action_config === 'string' ? JSON.parse(action_config || '{}') : (action_config || {})
  const mode = ac.mode === 'script' ? 'script' : 'declarative'
  if (mode === 'script') {
    if (!script || !String(script).trim()) throw new Error('script requis pour un webhook en mode script')
  } else {
    const steps = Array.isArray(ac.steps) ? ac.steps : []
    steps.forEach((s, i) => {
      const n = i + 1
      const type = s.type || 'update'
      if (!VALID_STEP_TYPES.has(type)) throw new Error(`Étape ${n}: type invalide (${type})`)
      if (!WEBHOOK_TABLES.has(s.table)) throw new Error(`Étape ${n}: table non autorisée (${s.table})`)
      if (type !== 'create') {
        if (!IDENT_RE.test(s.match?.field || '')) throw new Error(`Étape ${n}: champ de recherche requis`)
        if (!s.match?.param) throw new Error(`Étape ${n}: paramètre de recherche requis`)
      }
      for (const f of (s.fields || [])) {
        if (!IDENT_RE.test(f.column || '')) throw new Error(`Étape ${n}: colonne invalide (${f.column})`)
        if (f.source && !VALID_VALUE_SOURCES.has(f.source)) throw new Error(`Étape ${n}: source de valeur invalide (${f.source})`)
      }
    })
  }
  for (const r of (ac.response_rules || [])) {
    if (!r.param) throw new Error('Règle de réponse : paramètre requis')
  }
  if (ac.failure_recipient) {
    const allowed = listFromAddresses()
    if (!allowed.includes(ac.failure_recipient)) {
      throw new Error(`Destinataire d'échec « ${ac.failure_recipient} » non autorisé`)
    }
  }
}
// Comparison operators that require a finite numeric `value` and compare the
// column numerically (CAST AS REAL). Kept in sync with fieldRuleEngine.js.
const NUMERIC_OPS = new Set(['gt', 'gte', 'lt', 'lte'])
// `date_offset` is a date-relative trigger (« N jours avant/après un champ date »).
// It carries offset_days (signed int) + optional secondary filter instead of a value.
const VALID_OPS = new Set(['eq', 'ne', 'in', 'not_null', 'date_offset', ...NUMERIC_OPS])
// Operators allowed inside a date_offset secondary filter (everything except date_offset itself).
const FILTER_OPS = new Set(['eq', 'ne', 'in', 'not_null', ...NUMERIC_OPS])

// Validate a single { column, op, value } condition (used by multi-condition
// rules and the date_offset secondary filter). `label` prefixes error messages.
function validateCondition(cond, label) {
  if (!cond || typeof cond !== 'object') throw new Error(`${label} invalide`)
  if (!IDENT_RE.test(cond.column || '')) throw new Error(`${label}: colonne invalide`)
  const cop = cond.op || 'eq'
  if (!FILTER_OPS.has(cop)) throw new Error(`${label}: opérateur invalide (${cop})`)
  if (cop !== 'not_null' && cond.value === undefined) throw new Error(`${label}: valeur requise`)
  if (NUMERIC_OPS.has(cop) && !Number.isFinite(Number(cond.value))) {
    throw new Error(`${label}: valeur numérique requise pour l'opérateur ${cop}`)
  }
}

// Admin-facing field rule validation. Throws on first error.
function validateFieldRule({ trigger_config, action_type, action_config }) {
  const tc = typeof trigger_config === 'string' ? JSON.parse(trigger_config) : trigger_config
  if (!tc || typeof tc !== 'object') throw new Error('trigger_config invalide')
  if (!IDENT_RE.test(tc.erp_table || '')) throw new Error('trigger_config.erp_table invalide')
  const op = tc.op || 'eq'
  if (!VALID_OPS.has(op)) throw new Error(`trigger_config.op invalide: ${op}`)
  if (op === 'date_offset') {
    if (!IDENT_RE.test(tc.column || '')) throw new Error('trigger_config.column invalide')
    if (!Number.isInteger(Number(tc.offset_days))) {
      throw new Error('trigger_config.offset_days doit être un entier (négatif = avant, positif = après)')
    }
    if (tc.filter != null) {
      validateCondition(tc.filter, 'trigger_config.filter')
    }
  } else if (tc.conditions != null) {
    // Multi-condition AND/OR mode — { conjunction, rules: [{column, op, value}] }
    if (typeof tc.conditions !== 'object') throw new Error('trigger_config.conditions invalide')
    if (tc.conditions.conjunction !== 'AND' && tc.conditions.conjunction !== 'OR') {
      throw new Error('trigger_config.conditions.conjunction doit être AND ou OR')
    }
    const rules = tc.conditions.rules
    if (!Array.isArray(rules) || rules.length === 0) {
      throw new Error('trigger_config.conditions.rules requis (au moins une condition)')
    }
    rules.forEach((r, i) => validateCondition(r, `Condition ${i + 1}`))
  } else {
    if (!IDENT_RE.test(tc.column || '')) throw new Error('trigger_config.column invalide')
    if (op !== 'not_null' && tc.value === undefined) throw new Error('trigger_config.value requise')
    if (NUMERIC_OPS.has(op) && !Number.isFinite(Number(tc.value))) {
      throw new Error(`trigger_config.value doit être numérique pour l'opérateur ${op}`)
    }
  }
  const at = action_type || 'slack'
  if (!VALID_ACTION_TYPES.has(at)) throw new Error(`action_type invalide: ${at}`)
  const ac = typeof action_config === 'string' ? JSON.parse(action_config) : (action_config || {})
  // Anti-cycle: interdire une règle tâche qui écrirait dans la même table que le trigger
  if (at === 'task' && ac.link_company === false && tc.erp_table === 'tasks') {
    throw new Error('Garde anti-cycle: règle sur `tasks` avec action task interdite')
  }
  if (at === 'script' && (!ac.script || !String(ac.script).trim())) {
    throw new Error('action_config.script requis pour une règle de type script')
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

// ── Historique de versions ────────────────────────────────────────────────
// Chaque édition sauvegardée (POST create, PATCH update, restore) capture un
// snapshot complet de l'automation + qui/quand → audit + rollback. Les éditions
// rapprochées du même auteur (autosave debounce 500ms) sont coalescées dans la
// même ligne de version pour éviter une révision par frappe.
const VERSION_COALESCE_MS = 2 * 60 * 1000
const VERSION_FIELDS = ['name', 'description', 'trigger_type', 'trigger_config', 'action_type', 'action_config', 'script', 'active', 'kind']
const VERSION_FIELD_LABELS = {
  name: 'nom', description: 'description', trigger_type: 'type de déclencheur',
  trigger_config: 'déclencheur', action_type: 'type d\'action',
  action_config: 'action', script: 'script', active: 'statut', kind: 'genre',
}

// Normalise une valeur pour comparaison (active → 0/1 ; null/undefined → '').
function vnorm(field, val) {
  if (field === 'active') return val ? 1 : 0
  return val == null ? '' : String(val)
}
function sameVersionContent(a, b) {
  return VERSION_FIELDS.every(f => vnorm(f, a[f]) === vnorm(f, b[f]))
}
// Liste lisible des champs qui diffèrent entre deux snapshots.
function versionDiffSummary(prev, next) {
  if (!prev) return 'Création'
  const changed = VERSION_FIELDS.filter(f => vnorm(f, prev[f]) !== vnorm(f, next[f]))
  if (!changed.length) return 'Aucun changement'
  return changed.map(f => VERSION_FIELD_LABELS[f] || f).join(', ') + (changed.length > 1 ? ' modifiés' : ' modifié')
}
// Construit un snapshot versionnable depuis une ligne `automations`.
function snapshotFromRow(row) {
  return {
    name: row.name, description: row.description, trigger_type: row.trigger_type,
    trigger_config: row.trigger_config, action_type: row.action_type,
    action_config: row.action_config, script: row.script,
    active: row.active ? 1 : 0, kind: row.kind || null,
  }
}

// Enregistre une révision. No-op si identique à la dernière (sauf summary forcé).
// Coalesce les éditions rapprochées du même auteur (remplace la dernière ligne).
// opts.coalesce=false force une nouvelle ligne ; opts.summary force le résumé.
function recordAutomationVersion(automationId, snapshot, req, opts = {}) {
  const latest = db.prepare(
    'SELECT * FROM automation_versions WHERE automation_id = ? ORDER BY version DESC LIMIT 1'
  ).get(automationId)
  if (latest && sameVersionContent(latest, snapshot) && !opts.summary) return latest

  const userId = req?.user?.id || null
  const userName = req?.user?.name || null
  const coalesce = opts.coalesce !== false && latest &&
    userId != null && latest.edited_by === userId &&
    (Date.now() - Date.parse(latest.created_at || 0)) < VERSION_COALESCE_MS
  // Base du diff : la révision d'avant `latest` si on coalesce (on l'écrase), sinon `latest`.
  const diffBase = coalesce
    ? db.prepare('SELECT * FROM automation_versions WHERE automation_id = ? AND version < ? ORDER BY version DESC LIMIT 1').get(automationId, latest.version)
    : latest
  const summary = opts.summary || versionDiffSummary(diffBase, snapshot)

  if (coalesce) {
    db.prepare(`
      UPDATE automation_versions SET
        name=?, description=?, trigger_type=?, trigger_config=?, action_type=?,
        action_config=?, script=?, active=?, kind=?, edited_by=?, edited_by_name=?,
        change_summary=?, created_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id=?
    `).run(snapshot.name, snapshot.description, snapshot.trigger_type, snapshot.trigger_config,
      snapshot.action_type, snapshot.action_config, snapshot.script, snapshot.active ? 1 : 0,
      snapshot.kind, userId, userName, summary, latest.id)
    return db.prepare('SELECT * FROM automation_versions WHERE id = ?').get(latest.id)
  }

  const version = latest ? latest.version + 1 : 1
  const id = newId('version')
  db.prepare(`
    INSERT INTO automation_versions
      (id, automation_id, version, name, description, trigger_type, trigger_config,
       action_type, action_config, script, active, kind, edited_by, edited_by_name, change_summary)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(id, automationId, version, snapshot.name, snapshot.description, snapshot.trigger_type,
    snapshot.trigger_config, snapshot.action_type, snapshot.action_config, snapshot.script,
    snapshot.active ? 1 : 0, snapshot.kind, userId, userName, summary)
  return db.prepare('SELECT * FROM automation_versions WHERE id = ?').get(id)
}

// Garantit qu'une automation pré-existante a une révision « état initial » avant
// d'enregistrer l'édition courante — sinon impossible de revenir à l'état d'avant
// la première édition tracée.
function ensureBaselineVersion(automationRow) {
  const { c } = db.prepare('SELECT COUNT(*) c FROM automation_versions WHERE automation_id = ?').get(automationRow.id)
  if (c > 0) return
  const snap = snapshotFromRow(automationRow)
  db.prepare(`
    INSERT INTO automation_versions
      (id, automation_id, version, name, description, trigger_type, trigger_config,
       action_type, action_config, script, active, kind, edited_by, edited_by_name, change_summary)
    VALUES (?,?,1,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(newId('version'), automationRow.id, snap.name, snap.description, snap.trigger_type,
    snap.trigger_config, snap.action_type, snap.action_config, snap.script, snap.active ? 1 : 0,
    snap.kind, null, null, 'État initial (avant suivi de versions)')
}

const router = Router()
router.use(requireAuth)

// GET /api/automations
router.get('/', (req, res) => {
  const automations = db.prepare(`
    SELECT a.*,
           COALESCE(r.runs_30d, 0) AS runs_30d,
           COALESCE(r.errors_30d, 0) AS errors_30d
    FROM automations a
    LEFT JOIN (
      SELECT automation_id,
             COUNT(*) AS runs_30d,
             SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors_30d
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
  if (!trigger_type && kind !== 'field_rule' && kind !== 'webhook') return res.status(400).json({ error: 'trigger_type requis' })

  const isFieldRule = kind === 'field_rule'
  const isWebhook = kind === 'webhook'
  let at = 'script', acJson = '{}', tcJson = trigger_config || '{}', tt = trigger_type
  let webhookToken = null
  if (isFieldRule) {
    try {
      validateFieldRule({ trigger_config, action_type, action_config })
    } catch (e) { return res.status(400).json({ error: e.message }) }
    at = action_type
    acJson = typeof action_config === 'string' ? action_config : JSON.stringify(action_config || {})
    tcJson = typeof trigger_config === 'string' ? trigger_config : JSON.stringify(trigger_config || {})
    tt = 'field_rule'
  } else if (isWebhook) {
    try {
      validateWebhook({ action_config, script })
    } catch (e) { return res.status(400).json({ error: e.message }) }
    at = 'webhook'
    tt = 'webhook'
    acJson = typeof action_config === 'string' ? action_config : JSON.stringify(action_config || {})
    tcJson = typeof trigger_config === 'string' ? trigger_config : JSON.stringify(trigger_config || {})
    webhookToken = newWebhookToken()
  }

  const id = newId('auto')
  db.prepare(`
    INSERT INTO automations (id, name, description, trigger_type, trigger_config, action_type, action_config, script, active, kind, webhook_token)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name.trim(), description || null, tt,
    tcJson, at, acJson, isFieldRule ? '' : (script || ''),
    active !== undefined ? active : 1, isFieldRule ? 'field_rule' : (isWebhook ? 'webhook' : null), webhookToken)

  const created = db.prepare('SELECT * FROM automations WHERE id = ?').get(id)
  recordAutomationVersion(id, snapshotFromRow(created), req, { coalesce: false })

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
    ensureBaselineVersion(automation)
    db.prepare(`
      UPDATE automations SET
        active = COALESCE(?, active),
        action_config = COALESCE(?, action_config),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(active ?? null, nextActionConfigJson, req.params.id)
    const updated = db.prepare('SELECT * FROM automations WHERE id = ?').get(req.params.id)
    recordAutomationVersion(updated.id, snapshotFromRow(updated), req)
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

  // Webhook edits: revalider la config déclarative / script si elle change.
  if (automation.kind === 'webhook' && (action_config !== undefined || script !== undefined)) {
    try {
      validateWebhook({
        action_config: action_config ?? automation.action_config,
        script: script ?? automation.script,
      })
    } catch (e) { return res.status(400).json({ error: e.message }) }
  }

  ensureBaselineVersion(automation)
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
  recordAutomationVersion(updated.id, snapshotFromRow(updated), req)

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

// GET /api/automations/:id/versions
// Historique des révisions (snapshot complet + qui/quand), plus récent d'abord.
router.get('/:id/versions', (req, res) => {
  const automation = db.prepare(
    'SELECT id FROM automations WHERE id = ? AND deleted_at IS NULL'
  ).get(req.params.id)
  if (!automation) return res.status(404).json({ error: 'Introuvable' })
  const versions = db.prepare(`
    SELECT * FROM automation_versions WHERE automation_id = ? ORDER BY version DESC LIMIT 100
  `).all(req.params.id)
  res.json(versions)
})

// POST /api/automations/:id/versions/:versionId/restore
// Restaure la configuration (déclencheur/action/script) d'une révision passée.
// Le statut actif/inactif courant N'est PAS touché (éviter une réactivation
// surprise d'une règle désactivée). Crée une nouvelle révision marqueur.
router.post('/:id/versions/:versionId/restore', (req, res) => {
  const automation = db.prepare(
    'SELECT * FROM automations WHERE id = ? AND deleted_at IS NULL'
  ).get(req.params.id)
  if (!automation) return res.status(404).json({ error: 'Introuvable' })
  if (automation.system) {
    return res.status(403).json({ error: 'Automation système — restauration interdite' })
  }
  const version = db.prepare(
    'SELECT * FROM automation_versions WHERE id = ? AND automation_id = ?'
  ).get(req.params.versionId, req.params.id)
  if (!version) return res.status(404).json({ error: 'Version introuvable' })

  // Revalider la config restaurée selon le genre (une vieille version peut être
  // invalide vis-à-vis de règles de validation ajoutées depuis).
  if (automation.kind === 'field_rule') {
    try {
      validateFieldRule({
        trigger_config: version.trigger_config,
        action_type: version.action_type,
        action_config: version.action_config,
      })
    } catch (e) { return res.status(400).json({ error: `Version invalide : ${e.message}` }) }
  } else if (automation.kind === 'webhook') {
    try {
      validateWebhook({ action_config: version.action_config, script: version.script })
    } catch (e) { return res.status(400).json({ error: `Version invalide : ${e.message}` }) }
  }

  ensureBaselineVersion(automation)
  db.prepare(`
    UPDATE automations SET
      name = ?, description = ?, trigger_type = ?, trigger_config = ?,
      action_type = ?, action_config = ?, script = ?,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(version.name, version.description, version.trigger_type, version.trigger_config,
    version.action_type, version.action_config, version.script, req.params.id)

  const updated = db.prepare('SELECT * FROM automations WHERE id = ?').get(req.params.id)
  recordAutomationVersion(updated.id, snapshotFromRow(updated), req, {
    coalesce: false, summary: `Restauration de la version ${version.version}`,
  })

  if (updated.trigger_type === 'schedule') {
    if (updated.active) scheduleAutomation(updated)
    else unscheduleAutomation(updated.id)
  } else {
    unscheduleAutomation(updated.id)
  }

  res.json(updated)
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

// GET /api/automations/:id/deferred-queue — backpressure depth gauge.
// When an evaluation matches more rows than CANDIDATE_CAP can dispatch, the
// overflow is parked in automation_deferred_candidates and drained batch by batch.
// Exposes the current depth (+ oldest entry + a sample of pending ids) so a rule
// quietly chewing through thousands of matches becomes observable.
router.get('/:id/deferred-queue', (req, res) => {
  const automation = db.prepare(
    'SELECT id, kind FROM automations WHERE id = ? AND deleted_at IS NULL'
  ).get(req.params.id)
  if (!automation) return res.status(404).json({ error: 'Introuvable' })
  const { depth, oldest } = db.prepare(`
    SELECT COUNT(*) AS depth, MIN(enqueued_at) AS oldest
    FROM automation_deferred_candidates WHERE automation_id = ?
  `).get(req.params.id)
  const items = db.prepare(`
    SELECT record_table, record_id, enqueued_at
    FROM automation_deferred_candidates
    WHERE automation_id = ?
    ORDER BY enqueued_at ASC
    LIMIT 100
  `).all(req.params.id)
  res.json({ depth, oldest_enqueued_at: oldest, batch_size: CANDIDATE_CAP, items })
})

// POST /api/automations/:id/drain-deferred — force an immediate drain of one
// batch (CANDIDATE_CAP) from this rule's deferred queue. Dispatches real actions.
router.post('/:id/drain-deferred', async (req, res) => {
  const automation = db.prepare(
    'SELECT id, kind FROM automations WHERE id = ? AND deleted_at IS NULL'
  ).get(req.params.id)
  if (!automation) return res.status(404).json({ error: 'Introuvable' })
  if (automation.kind !== 'field_rule') {
    return res.status(400).json({ error: 'Disponible uniquement pour les règles de champ' })
  }
  try {
    const out = await drainDeferredForAutomation(req.params.id)
    res.json({ status: 'success', ...out })
  } catch (e) {
    res.status(400).json({ status: 'error', error: e.message })
  }
})

// POST /api/automations/:id/test
//  - field_rule : dry-run sans dispatch ni insertion de fires
//  - webhook    : dry-run déclaratif (matches + réponse calculés, AUCUNE écriture)
//                 avec les params fournis dans le body { params: {...} }
router.post('/:id/test', async (req, res) => {
  const automation = db.prepare(
    'SELECT * FROM automations WHERE id = ? AND deleted_at IS NULL'
  ).get(req.params.id)
  if (!automation) return res.status(404).json({ error: 'Introuvable' })

  if (automation.kind === 'webhook') {
    try {
      const params = (req.body?.params && typeof req.body.params === 'object') ? req.body.params : {}
      const out = await runWebhook(automation, {
        method: 'POST', query: {}, body: params, params, headers: {}, dryRun: true,
      })
      return res.json(out)
    } catch (e) {
      return res.status(400).json({ error: e.message })
    }
  }

  if (automation.kind !== 'field_rule') {
    return res.status(400).json({ error: 'Test disponible uniquement pour les règles de champ et les webhooks' })
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

// POST /api/automations/:id/run-date-rule
// Exécute immédiatement une règle de date relative (op date_offset) « comme
// aujourd'hui » : dispatch réel des actions + enregistrement des fires (dedup).
// Sert au bouton « Lancer maintenant » et permet de tester sans attendre le cron.
router.post('/:id/run-date-rule', async (req, res) => {
  const automation = db.prepare(
    'SELECT id, kind FROM automations WHERE id = ? AND deleted_at IS NULL'
  ).get(req.params.id)
  if (!automation) return res.status(404).json({ error: 'Introuvable' })
  if (automation.kind !== 'field_rule') {
    return res.status(400).json({ error: 'Disponible uniquement pour les règles de champ' })
  }
  try {
    const out = await runDateOffsetRuleNow(req.params.id)
    res.json({ status: 'success', ...out })
  } catch (e) {
    res.status(400).json({ status: 'error', error: e.message })
  }
})

// POST /api/automations/:id/rotate-token — régénère le token d'un webhook (révoque l'ancien)
router.post('/:id/rotate-token', (req, res) => {
  const automation = db.prepare(
    'SELECT id, kind FROM automations WHERE id = ? AND deleted_at IS NULL'
  ).get(req.params.id)
  if (!automation) return res.status(404).json({ error: 'Introuvable' })
  if (automation.kind !== 'webhook') {
    return res.status(400).json({ error: 'Rotation disponible uniquement pour les webhooks' })
  }
  const token = newWebhookToken()
  db.prepare(`
    UPDATE automations SET webhook_token = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(token, req.params.id)
  res.json({ webhook_token: token })
})

// Max attempts before a webhook retry is abandoned — mirrors processRetryQueue()
// in server/src/services/airtableWebhooks.js. Keep in sync.
const WEBHOOK_RETRY_MAX_ATTEMPTS = 5

// GET /api/automations/:id/retry-queue
// Exposes the Airtable webhook retry queue (table webhook_sync_retry) so the
// "1 module(s) en échec (retry queue)" log line becomes actionable: which
// module, which error, how many attempts, and when the next retry fires.
// Only meaningful for sys_airtable_webhook_router.
router.get('/:id/retry-queue', (req, res) => {
  if (req.params.id !== 'sys_airtable_webhook_router') {
    return res.status(404).json({ error: 'File de retry indisponible pour cette automation' })
  }
  const rows = db.prepare(`
    SELECT id, module, attempts, last_error, created_at, next_retry_at
    FROM webhook_sync_retry
    ORDER BY next_retry_at ASC
  `).all()
  res.json({ items: rows, max_attempts: WEBHOOK_RETRY_MAX_ATTEMPTS })
})

// POST /api/automations/:id/retry-queue/:retryId/retry
// Force an immediate retry of one queued module: reset next_retry_at to now,
// then drain the due queue. Returns the refreshed queue.
router.post('/:id/retry-queue/:retryId/retry', async (req, res) => {
  if (req.params.id !== 'sys_airtable_webhook_router') {
    return res.status(404).json({ error: 'File de retry indisponible pour cette automation' })
  }
  const row = db.prepare('SELECT id FROM webhook_sync_retry WHERE id = ?').get(req.params.retryId)
  if (!row) return res.status(404).json({ error: 'Entrée de retry introuvable' })

  db.prepare(
    "UPDATE webhook_sync_retry SET next_retry_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
  ).run(req.params.retryId)

  try {
    await processRetryQueue()
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }

  const items = db.prepare(`
    SELECT id, module, attempts, last_error, created_at, next_retry_at
    FROM webhook_sync_retry
    ORDER BY next_retry_at ASC
  `).all()
  res.json({ items, max_attempts: WEBHOOK_RETRY_MAX_ATTEMPTS })
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
    const candidates = eligibles.slice(0, 50).map(c => ({
      id: c.company_id, label: c.company_name,
    }))

    const requestedId = req.query.record_id ? String(req.query.record_id) : null
    let candidate = null
    if (requestedId) {
      candidate = eligibles.find(c => c.company_id === requestedId) || null
    }
    if (!candidate) {
      candidate = eligibles.find(c =>
        (language === 'French' ? (c.contact_language || c.company_language || '').toLowerCase().startsWith('fr') : true)
      ) || eligibles[0] || null
    }

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
      candidates,
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
    // Ne pas avaler une config corrompue : un action_config JSON invalide
    // ferait tourner l'aperçu (et l'exécution) avec {} — l'automation paraît
    // marcher mais n'envoie rien. On remonte une erreur explicite.
    let actionConfig
    try {
      actionConfig = JSON.parse(automation.action_config || '{}')
    } catch (e) {
      return res.status(400).json({
        available: false,
        invalid_config: true,
        error: `Configuration de l'automation corrompue : action_config n'est pas du JSON valide (${e.message}). Corrigez-la avant d'utiliser cette automation.`,
      })
    }
    try {
      const rule = {
        id: automation.id,
        trigger_config: JSON.parse(automation.trigger_config || '{}'),
        action_type: 'email',
        action_config: actionConfig,
      }
      // previewLimit 50 → the picker lists up to 50 matching records; rendering
      // each is cheap and avoids a second query when one is selected.
      const out = dryRunFieldRule(rule, { previewLimit: 50 })
      const candidates = out.previews.map(p => ({
        id: p.id, label: p.label, already_fired: !!p.already_fired,
      }))

      // Pick the record to render: the explicitly-requested one (if any), else
      // the first candidate that renders cleanly.
      const requestedId = req.query.record_id ? String(req.query.record_id) : null
      let chosen = null
      if (requestedId) {
        chosen = out.previews.find(p => p.id === requestedId) || null
        // Requested record is outside the candidate set (doesn't match the
        // trigger, or beyond the 50-row window) — render it on demand so the
        // user can still preview any record they pick.
        if (!chosen) chosen = previewRuleForRecord(rule, requestedId)
        if (!chosen) {
          return res.status(404).json({
            available: false,
            error: `Record introuvable: ${requestedId}`,
          })
        }
      } else {
        chosen = out.previews.find(p => !p.error && p.rendered) || null
      }

      if (chosen && chosen.rendered) {
        return res.json({
          available: true, kind: 'field_rule', automation_id: automation.id,
          subject: chosen.rendered.subject || '',
          bodyHtml: chosen.rendered.bodyHtml || '',
          bodyText: chosen.rendered.bodyText || '',
          from: chosen.rendered.from || null,
          to: chosen.rendered.to || null,
          sample: true,
          sample_record: { id: chosen.id, label: chosen.label },
          matches_trigger: chosen.matches_trigger !== false,
          candidates,
          candidates_total: out.candidates_total,
        })
      }
      if (chosen && chosen.error) {
        // The chosen record exists but its template failed to render.
        return res.json({
          available: true, kind: 'field_rule', automation_id: automation.id,
          subject: '', bodyHtml: '', bodyText: '',
          from: actionConfig.from || null, to: actionConfig.to || null,
          sample: true,
          sample_record: { id: chosen.id, label: chosen.label },
          render_error: chosen.error,
          candidates,
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
        candidates,
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
