import db from '../db/database.js'
import { logRuleRun } from './systemAutomations.js'
import { sendSlack } from './ruleActions/slack.js'
import { sendEmail } from './ruleActions/email.js'
import { createTask } from './ruleActions/task.js'

// Registry of channel adapters. Each adapter is async ({ rule, row, rendered }) => void
// and throws on failure. New channels are added here.
const ACTION_ADAPTERS = {
  slack: sendSlack,
  email: sendEmail,
  task: createTask,
}

const FEATURE_ENABLED = () => process.env.FEATURE_FIELD_RULES === 'true'

// Per-evaluation cap — prevents webhook timeouts. Excess candidates stay in the
// table and will be picked up on the next sync that touches the trigger field.
const CANDIDATE_CAP = 50

// Columns always allowed in templates on top of airtable_field_defs entries.
// `company_name` and `app_url` are synthetic fields injected by the engine.
const ALWAYS_ALLOWED = new Set(['id', 'airtable_id', 'created_at', 'updated_at', 'company_name', 'app_url'])

const IDENT_RE = /^[a-z_][a-z0-9_]*$/i

export async function evaluateFieldRules({ erpTable, tableId, changes }) {
  if (!FEATURE_ENABLED()) return
  if (!IDENT_RE.test(erpTable)) return
  const rules = loadActiveRules(erpTable)
  if (!rules.length) return
  for (const rule of rules) {
    await evaluateOne(rule, { erpTable, tableId, changes })
  }
}

function loadActiveRules(erpTable) {
  const rows = db.prepare(`
    SELECT id, name, trigger_config, action_type, action_config
    FROM automations
    WHERE kind='field_rule' AND active=1 AND deleted_at IS NULL
  `).all()
  const out = []
  for (const r of rows) {
    try {
      const tc = JSON.parse(r.trigger_config || '{}')
      if (tc.erp_table !== erpTable) continue
      out.push({
        id: r.id,
        name: r.name,
        trigger_config: tc,
        action_type: r.action_type,
        action_config: JSON.parse(r.action_config || '{}'),
      })
    } catch {
      // Malformed JSON — log once per run so admins notice
      try {
        logRuleRun(r.id, {
          status: 'error',
          error: 'trigger_config ou action_config JSON invalide',
          duration_ms: 0,
        })
      } catch {}
    }
  }
  return out
}

async function evaluateOne(rule, { erpTable, tableId, changes }) {
  const started = Date.now()
  try {
    const { column, op = 'eq', value } = rule.trigger_config
    if (!column || !IDENT_RE.test(column)) {
      throw new Error(`Colonne trigger invalide: ${column}`)
    }

    // Confirm column physically exists on the table
    const tableCols = db.prepare(`PRAGMA table_info(${erpTable})`).all().map(c => c.name)
    if (!tableCols.includes(column)) {
      throw new Error(`Colonne inexistante: ${erpTable}.${column}`)
    }

    // Webhook gating: skip evaluation if the trigger field wasn't touched.
    // changes === null|undefined means a full sync (scheduled / manual) — always run.
    if (changes != null) {
      const entry = changes[tableId]
      if (!entry) return
      const fieldId = resolveAirtableFieldId(erpTable, column)
      const touched = fieldId && Array.isArray(entry.changedFieldIds)
        && entry.changedFieldIds.includes(fieldId)
      if (!entry.hasCreates && !touched) return
    }

    const { sql, params } = buildCandidateQuery(rule, erpTable, column, op, value)
    const candidates = db.prepare(sql).all(...params)
    if (candidates.length === 0) return // quiet exit — no noise

    const adapter = ACTION_ADAPTERS[rule.action_type]
    if (!adapter) {
      throw new Error(`Adaptateur inconnu: ${rule.action_type}`)
    }

    const batch = candidates.slice(0, CANDIDATE_CAP)
    const deferred = Math.max(0, candidates.length - batch.length)
    const fired = []
    const failed = []
    const insertFire = db.prepare(`
      INSERT OR IGNORE INTO automation_rule_fires (automation_id, record_table, record_id)
      VALUES (?, ?, ?)
    `)

    const appUrl = (process.env.APP_URL || 'https://customer.orisha.io').replace(/\/$/, '')
    for (const row of batch) {
      row.app_url = appUrl
      try {
        const rendered = renderActionConfig(rule.action_config, row, erpTable)
        await adapter({ rule, row, rendered })
        insertFire.run(rule.id, erpTable, row.id)
        fired.push({ id: row.id, label: row.title || row.name || row.id })
      } catch (e) {
        failed.push({ id: row.id, error: e.message })
      }
    }

    const lines = [
      `${fired.length} tir(s), ${failed.length} échec(s)` +
        (deferred ? `, ${deferred} différé(s)` : ''),
    ]
    if (fired.length) {
      lines.push('', 'Déclenchés :')
      for (const f of fired) lines.push(`  • ${f.label} (${f.id})`)
    }
    if (failed.length) {
      lines.push('', 'Échecs :')
      for (const f of failed) lines.push(`  • ${f.id} — ${f.error}`)
    }

    logRuleRun(rule.id, {
      status: failed.length > 0 ? 'error' : 'success',
      result: lines.join('\n'),
      error: failed.length > 0 ? `${failed.length} tir(s) en échec` : null,
      duration_ms: Date.now() - started,
      triggerData: {
        candidates: candidates.length,
        fired: fired.length,
        deferred,
      },
    })
  } catch (e) {
    logRuleRun(rule.id, {
      status: 'error',
      error: e.message,
      duration_ms: Date.now() - started,
    })
  }
}

function resolveAirtableFieldId(erpTable, column) {
  const row = db.prepare(`
    SELECT airtable_field_id FROM airtable_field_defs
    WHERE erp_table=? AND column_name=? AND airtable_field_id NOT LIKE 'webhook_%'
    LIMIT 1
  `).get(erpTable, column)
  return row?.airtable_field_id || null
}

function buildCandidateQuery(rule, erpTable, column, op, value) {
  const tableCols = db.prepare(`PRAGMA table_info(${erpTable})`).all().map(c => c.name)
  const hasCompany = tableCols.includes('company_id')
  const selectFrom = hasCompany
    ? `SELECT t.*, c.name AS company_name FROM ${erpTable} t LEFT JOIN companies c ON t.company_id = c.id`
    : `SELECT t.* FROM ${erpTable} t`
  const base = `
    ${selectFrom}
    WHERE `
  const notFired = `
      AND NOT EXISTS (
        SELECT 1 FROM automation_rule_fires f
        WHERE f.automation_id=? AND f.record_table=? AND f.record_id=t.id
      )
    LIMIT ${CANDIDATE_CAP * 4}
  `
  if (op === 'not_null') {
    return {
      sql: `${base} t.${column} IS NOT NULL AND t.${column} != '' ${notFired}`,
      params: [rule.id, erpTable],
    }
  }
  if (op === 'in') {
    const arr = Array.isArray(value) ? value : []
    if (!arr.length) return { sql: `${base} 1=0 ${notFired}`, params: [rule.id, erpTable] }
    const ph = arr.map(() => '?').join(',')
    return { sql: `${base} t.${column} IN (${ph}) ${notFired}`, params: [...arr, rule.id, erpTable] }
  }
  const opSql = op === 'ne' ? '!=' : '='
  return {
    sql: `${base} t.${column} ${opSql} ? ${notFired}`,
    params: [value, rule.id, erpTable],
  }
}

/**
 * Render {{column}} placeholders in every string value of action_config using
 * columns from the triggering row. Columns must be whitelisted (native columns
 * of erpTable + airtable_field_defs). Unknown keys are left literal to surface
 * the typo. Rejects templates containing `<script` outright.
 */
export function renderActionConfig(actionConfig, row, erpTable) {
  const allowed = buildAllowedColumns(erpTable)
  const out = {}
  for (const [k, v] of Object.entries(actionConfig || {})) {
    out[k] = substitute(v, row, allowed)
  }
  return out
}

function buildAllowedColumns(erpTable) {
  const s = new Set(ALWAYS_ALLOWED)
  for (const c of db.prepare(`PRAGMA table_info(${erpTable})`).all()) s.add(c.name)
  for (const r of db.prepare(
    `SELECT column_name FROM airtable_field_defs WHERE erp_table=?`
  ).all(erpTable)) s.add(r.column_name)
  return s
}

function substitute(tpl, row, allowed) {
  if (typeof tpl !== 'string') return tpl
  if (/<script/i.test(tpl)) throw new Error('Template refusé: balise <script> interdite')
  return tpl.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_m, key) => {
    if (!allowed.has(key)) return `{{${key}}}`
    const v = row[key]
    return v == null ? '' : String(v)
  })
}

/**
 * Dry-run a field rule: returns matching candidates and rendered payloads
 * without dispatching any adapter and without inserting into
 * automation_rule_fires. Used by the rule editor "Tester" button.
 *
 * `rule` must be the admin-facing shape:
 *   { id, trigger_config: {...}, action_type, action_config: {...} }
 */
export function dryRunFieldRule(rule, { previewLimit = 10 } = {}) {
  const tc = rule.trigger_config || {}
  const erpTable = tc.erp_table
  const column = tc.column
  const op = tc.op || 'eq'
  const value = tc.value
  if (!erpTable || !IDENT_RE.test(erpTable)) {
    throw new Error(`erp_table invalide: ${erpTable}`)
  }
  if (!column || !IDENT_RE.test(column)) {
    throw new Error(`column invalide: ${column}`)
  }
  const tableCols = db.prepare(`PRAGMA table_info(${erpTable})`).all().map(c => c.name)
  if (!tableCols.includes(column)) {
    throw new Error(`Colonne inexistante: ${erpTable}.${column}`)
  }

  const hasCompany = tableCols.includes('company_id')
  const selectFrom = hasCompany
    ? `SELECT t.*, c.name AS company_name FROM ${erpTable} t LEFT JOIN companies c ON t.company_id = c.id`
    : `SELECT t.* FROM ${erpTable} t`
  let sql, params
  if (op === 'not_null') {
    sql = `${selectFrom} WHERE t.${column} IS NOT NULL AND t.${column} != '' LIMIT 200`
    params = []
  } else if (op === 'in') {
    const arr = Array.isArray(value) ? value : []
    if (!arr.length) {
      sql = `${selectFrom} WHERE 1=0 LIMIT 200`
      params = []
    } else {
      const ph = arr.map(() => '?').join(',')
      sql = `${selectFrom} WHERE t.${column} IN (${ph}) LIMIT 200`
      params = [...arr]
    }
  } else {
    const opSql = op === 'ne' ? '!=' : '='
    sql = `${selectFrom} WHERE t.${column} ${opSql} ? LIMIT 200`
    params = [value]
  }

  const candidates = db.prepare(sql).all(...params)
  const firedIds = new Set(
    db.prepare('SELECT record_id FROM automation_rule_fires WHERE automation_id=?')
      .all(rule.id)
      .map(r => r.record_id)
  )
  const appUrl = (process.env.APP_URL || 'https://customer.orisha.io').replace(/\/$/, '')

  const previews = []
  for (const row of candidates.slice(0, previewLimit)) {
    row.app_url = appUrl
    const alreadyFired = firedIds.has(row.id)
    try {
      const rendered = renderActionConfig(rule.action_config, row, erpTable)
      previews.push({
        id: row.id,
        label: row.title || row.name || row.id,
        already_fired: alreadyFired,
        rendered,
        error: null,
      })
    } catch (e) {
      previews.push({
        id: row.id,
        label: row.title || row.name || row.id,
        already_fired: alreadyFired,
        rendered: null,
        error: e.message,
      })
    }
  }

  const wouldFire = candidates.filter(c => !firedIds.has(c.id)).length
  return {
    candidates_total: candidates.length,
    would_fire: wouldFire,
    already_fired: candidates.length - wouldFire,
    previews,
  }
}
