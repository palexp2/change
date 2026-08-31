import db from '../db/database.js'
import { logRuleRun } from './systemAutomations.js'
import { sendSlack } from './ruleActions/slack.js'
import { sendEmail } from './ruleActions/email.js'
import { createTask } from './ruleActions/task.js'
import { runScriptAction } from './ruleActions/script.js'
import { makeRateGuard } from './ruleActions/rateGuard.js'
import { APP_URL } from '../config/appUrl.js'

// Registry of channel adapters. Each adapter is async ({ rule, row, rendered }) => void
// and throws on failure. New channels are added here.
const ACTION_ADAPTERS = {
  slack: sendSlack,
  email: sendEmail,
  task: createTask,
  script: runScriptAction,
}

const FEATURE_ENABLED = () => process.env.FEATURE_FIELD_RULES === 'true'

// Per-evaluation cap — prevents webhook timeouts. Excess candidates are parked in
// automation_deferred_candidates (a visible backpressure queue) and drained batch
// by batch by the scheduler, so they fire even if the trigger field never changes
// again. Exported so the API/UI can label the batch size on the depth gauge.
export const CANDIDATE_CAP = 50

// Columns always allowed in templates on top of airtable_field_defs entries.
// `company_name` and `app_url` are synthetic fields injected by the engine.
const ALWAYS_ALLOWED = new Set(['id', 'airtable_id', 'created_at', 'updated_at', 'company_name', 'app_url'])

const IDENT_RE = /^[a-z_][a-z0-9_]*$/i

// Numeric comparison operators. The column is cast to REAL so TEXT-typed
// columns (most Airtable-synced fields) compare numerically rather than
// lexicographically. Kept in sync with VALID_OPS in routes/automations.js.
const NUMERIC_OP_SQL = { gt: '>', gte: '>=', lt: '<', lte: '<=' }

/**
 * Build the `<column> <op> ?`-style WHERE predicate (without the `WHERE`
 * keyword) plus its bound params, for a column referenced as `t.<column>`.
 * Shared by buildCandidateQuery (live) and dryRunFieldRule (preview) so the two
 * paths can never diverge. Returns { predicate, params }.
 */
export function buildOpPredicate(column, op, value) {
  if (op === 'not_null') {
    return { predicate: `t.${column} IS NOT NULL AND t.${column} != ''`, params: [] }
  }
  if (op === 'in') {
    const arr = Array.isArray(value) ? value : []
    if (!arr.length) return { predicate: '1=0', params: [] }
    const ph = arr.map(() => '?').join(',')
    return { predicate: `t.${column} IN (${ph})`, params: [...arr] }
  }
  if (NUMERIC_OP_SQL[op]) {
    return { predicate: `CAST(t.${column} AS REAL) ${NUMERIC_OP_SQL[op]} ?`, params: [Number(value)] }
  }
  const opSql = op === 'ne' ? '!=' : '='
  return { predicate: `t.${column} ${opSql} ?`, params: [value] }
}

/**
 * Combine several `{ column, op, value }` conditions with AND or OR into a single
 * parenthesized predicate. Mirrors the DataTable filter shape
 * ({ conjunction: 'AND'|'OR', rules: [...] }) so the two stay conceptually aligned.
 * Each column is re-validated against IDENT_RE (defense-in-depth — interpolated raw).
 * An empty rule set is an always-false predicate (matches nothing).
 */
export function buildConditionsPredicate(conditions) {
  const conj = conditions?.conjunction === 'OR' ? 'OR' : 'AND'
  const rules = Array.isArray(conditions?.rules) ? conditions.rules : []
  if (!rules.length) return { predicate: '1=0', params: [] }
  const parts = []
  const params = []
  for (const r of rules) {
    if (!IDENT_RE.test(r.column || '')) throw new Error(`Colonne de condition invalide: ${r.column}`)
    const p = buildOpPredicate(r.column, r.op || 'eq', r.value)
    parts.push(`(${p.predicate})`)
    params.push(...p.params)
  }
  return { predicate: `(${parts.join(` ${conj} `)})`, params }
}

/**
 * Distinct list of columns referenced by a trigger_config across all its shapes
 * (primary column, date_offset secondary filter, multi-condition rules). Used to
 * validate columns exist and to gate evaluation when a write touches any of them.
 */
export function triggerColumns(tc) {
  const cols = new Set()
  if (tc?.column) cols.add(tc.column)
  if (tc?.filter?.column) cols.add(tc.filter.column)
  if (Array.isArray(tc?.conditions?.rules)) {
    for (const r of tc.conditions.rules) if (r.column) cols.add(r.column)
  }
  return [...cols]
}

/**
 * Build the full WHERE predicate for a field-rule trigger_config, supporting:
 *   - classic single condition   { column, op, value }
 *   - multi-condition AND/OR      { conditions: { conjunction, rules:[{column,op,value}] } }
 *     « statut = Ouvert ET urgence > 5 » sans passer au mode script.
 *   - date-relative trigger       { column, op: 'date_offset', offset_days, filter? }
 *     « N jours avant/après un champ date ». `offset_days` is a signed integer:
 *       négatif = N jours AVANT la date (rappel J-N), positif = N jours APRÈS.
 *     Fires the day `date(column) == today + offset_days`, implemented by
 *     shifting `now` by `-offset_days` so the comparison stays on the column.
 *     Optional `filter` ({ column, op, value }) ANDs a secondary condition
 *     (ex. « 5 jours après la facture ET statut = Impayée »).
 * Returns { predicate, params } (without the `WHERE` keyword). Throws on a
 * malformed identifier (defense-in-depth — columns are interpolated raw).
 */
export function buildTriggerPredicate(tc) {
  const op = tc.op || 'eq'
  if (op !== 'date_offset') {
    if (tc.conditions && Array.isArray(tc.conditions.rules)) {
      return buildConditionsPredicate(tc.conditions)
    }
    return buildOpPredicate(tc.column, op, tc.value)
  }
  if (!IDENT_RE.test(tc.column || '')) throw new Error(`Colonne date invalide: ${tc.column}`)
  const offset = Number(tc.offset_days)
  if (!Number.isInteger(offset)) throw new Error('offset_days doit être un entier')
  // Shift `now` by the opposite of offset_days so the equality lands on the column.
  const shift = -offset
  const modifier = `${shift >= 0 ? '+' : ''}${shift} days`
  let predicate = `date(t.${tc.column}) = date('now', ?)`
  const params = [modifier]
  if (tc.filter && tc.filter.column) {
    if (!IDENT_RE.test(tc.filter.column)) throw new Error(`Colonne de filtre invalide: ${tc.filter.column}`)
    const f = buildOpPredicate(tc.filter.column, tc.filter.op || 'eq', tc.filter.value)
    predicate += ` AND ${f.predicate}`
    params.push(...f.params)
  }
  return { predicate, params }
}

export async function evaluateFieldRules({ erpTable, tableId, changes }) {
  if (!FEATURE_ENABLED()) return
  if (!IDENT_RE.test(erpTable)) return
  const rules = loadActiveRules(erpTable)
  if (!rules.length) return
  for (const rule of rules) {
    // Date-relative rules fire only via the daily scheduler / manual run, never
    // on a write or sync — their semantics are « as of today », not « on change ».
    if (rule.trigger_config?.op === 'date_offset') continue
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
    const tc = rule.trigger_config
    const op = tc.op || 'eq'
    const cols = triggerColumns(tc)
    if (!cols.length) throw new Error('Aucune colonne de déclencheur')
    for (const c of cols) {
      if (!IDENT_RE.test(c)) throw new Error(`Colonne trigger invalide: ${c}`)
    }

    // Confirm every referenced column physically exists on the table
    const tableCols = db.prepare(`PRAGMA table_info(${erpTable})`).all().map(c => c.name)
    for (const c of cols) {
      if (!tableCols.includes(c)) throw new Error(`Colonne inexistante: ${erpTable}.${c}`)
    }

    // Webhook gating: skip evaluation unless a record was created or one of the
    // trigger fields was touched. changes === null|undefined means a full sync
    // (scheduled / manual) — always run. Date-relative rules ignore field-level
    // gating (they're driven by the clock).
    if (changes != null && op !== 'date_offset') {
      const entry = changes[tableId]
      if (!entry) return zeroSummary()
      const touched = cols.some(c => {
        const fieldId = resolveAirtableFieldId(erpTable, c)
        return fieldId && Array.isArray(entry.changedFieldIds)
          && entry.changedFieldIds.includes(fieldId)
      })
      if (!entry.hasCreates && !touched) return zeroSummary()
    }

    const { sql, params } = buildCandidateQuery(rule, erpTable)
    const candidates = db.prepare(sql).all(...params)
    return await dispatchCandidates(rule, erpTable, candidates, started)
  } catch (e) {
    logRuleRun(rule.id, {
      status: 'error',
      error: e.message,
      duration_ms: Date.now() - started,
    })
    return { candidates: 0, fired: 0, failed: 0, deferred: 0, error: e.message }
  }
}

function zeroSummary() {
  return { candidates: 0, fired: 0, failed: 0, deferred: 0, suppressed: 0 }
}

// Last time a suppression-only run was logged, per automation. The deferred drain
// re-evaluates every couple of minutes; a fully throttled rule would otherwise log
// a run on every pass. We surface the suppression (visibility matters) but at most
// once per window so the run history stays readable. In-memory is fine — losing it
// on restart costs one extra log line.
const lastSuppressionLog = new Map()
function shouldLogSuppressionOnly(automationId, windowMin) {
  const now = Date.now()
  const prev = lastSuppressionLog.get(automationId)
  const minGapMs = Math.max(1, windowMin) * 60_000
  if (prev && now - prev < minGapMs) return false
  lastSuppressionLog.set(automationId, now)
  return true
}

/**
 * Evaluate active field rules for a single record after a direct ERP write
 * (PATCH/POST on a native route), as opposed to an Airtable sync. Bounded to
 * `recordId` so it stays O(1) on the hot write path — no table scan.
 *
 * `changedColumns` (optional) gates evaluation to rules whose trigger column was
 * actually touched; pass null to evaluate every rule on the table.
 */
export async function evaluateFieldRulesForRecord({ erpTable, recordId, changedColumns = null }) {
  if (!FEATURE_ENABLED()) return
  if (!IDENT_RE.test(erpTable)) return
  if (!recordId) return
  const rules = loadActiveRules(erpTable)
  if (!rules.length) return
  const changed = Array.isArray(changedColumns) ? new Set(changedColumns) : null
  for (const rule of rules) {
    // Date-relative rules never fire on a write — only via the daily scan.
    if (rule.trigger_config?.op === 'date_offset') continue
    if (changed) {
      // Skip only when NONE of the rule's columns were touched.
      const cols = triggerColumns(rule.trigger_config)
      if (cols.length && !cols.some(c => changed.has(c))) continue
    }
    await evaluateOneForRecord(rule, erpTable, recordId)
  }
}

async function evaluateOneForRecord(rule, erpTable, recordId) {
  const started = Date.now()
  try {
    const cols = triggerColumns(rule.trigger_config)
    if (!cols.length) throw new Error('Aucune colonne de déclencheur')
    for (const c of cols) {
      if (!IDENT_RE.test(c)) throw new Error(`Colonne trigger invalide: ${c}`)
    }
    const tableCols = db.prepare(`PRAGMA table_info(${erpTable})`).all().map(c => c.name)
    for (const c of cols) {
      if (!tableCols.includes(c)) throw new Error(`Colonne inexistante: ${erpTable}.${c}`)
    }
    const { sql, params } = buildCandidateQuery(rule, erpTable, recordId)
    const candidates = db.prepare(sql).all(...params)
    await dispatchCandidates(rule, erpTable, candidates, started)
  } catch (e) {
    logRuleRun(rule.id, {
      status: 'error',
      error: e.message,
      duration_ms: Date.now() - started,
    })
  }
}

/**
 * Render + dispatch a rule's action across its matching candidates, track fires
 * (dedup), and log the run. Throws on internal failure (unknown adapter) so the
 * caller's catch records it. A quiet no-op when there are no candidates.
 */
async function dispatchCandidates(rule, erpTable, candidates, started) {
  if (candidates.length === 0) return zeroSummary() // quiet exit — no noise

  const adapter = ACTION_ADAPTERS[rule.action_type]
  if (!adapter) {
    throw new Error(`Adaptateur inconnu: ${rule.action_type}`)
  }

  const batch = candidates.slice(0, CANDIDATE_CAP)
  const overflow = candidates.slice(CANDIDATE_CAP)
  const deferred = overflow.length
  const fired = []
  const failed = []
  const suppressed = []
  const insertFire = db.prepare(`
    INSERT OR IGNORE INTO automation_rule_fires (automation_id, record_table, record_id)
    VALUES (?, ?, ?)
  `)

  // Anti-spam guard for outgoing channels (email/slack): caps sends per recipient
  // and per automation over a sliding window. null for internal channels (task,
  // script) or when the rule opts out — those dispatch unthrottled as before.
  const guard = makeRateGuard(rule)

  const appUrl = APP_URL
  for (const row of batch) {
    row.app_url = appUrl
    try {
      const rendered = renderActionConfig(rule.action_config, row, erpTable)
      let verdict = null
      if (guard) {
        verdict = guard.check()
        if (!verdict.ok) {
          suppressed.push({ id: row.id, label: row.title || row.name || row.id, reason: verdict.reason })
          continue // not fired, not failed — re-queued below so it retries when the window clears
        }
      }
      await adapter({ rule, row, rendered })
      insertFire.run(rule.id, erpTable, row.id)
      if (guard) guard.record(verdict.recipient, erpTable, row.id)
      fired.push({ id: row.id, label: row.title || row.name || row.id })
    } catch (e) {
      failed.push({ id: row.id, error: e.message })
    }
  }

  // Maintain the backpressure queue: park both the overflow we couldn't reach this
  // run AND the candidates throttled by the anti-spam guard, so the background drain
  // retries them once the window clears (otherwise a write-triggered suppression
  // would be lost until the trigger field changed again). Clear anything we just
  // fired. INSERT OR IGNORE keeps re-enqueues idempotent across evaluations.
  enqueueDeferred(rule.id, erpTable, [...overflow.map(r => r.id), ...suppressed.map(s => s.id)])
  dequeueDeferred(rule.id, erpTable, fired.map(f => f.id))

  const lines = [
    `${fired.length} tir(s), ${failed.length} échec(s)` +
      (suppressed.length ? `, ${suppressed.length} bloqué(s) anti-spam` : '') +
      (deferred ? `, ${deferred} différé(s)` : ''),
  ]
  if (fired.length) {
    lines.push('', 'Déclenchés :')
    for (const f of fired) lines.push(`  • ${f.label} (${f.id})`)
  }
  if (suppressed.length) {
    lines.push('', 'Bloqués (plafond anti-spam) :')
    for (const s of suppressed) lines.push(`  • ${s.label} (${s.id}) — ${s.reason}`)
  }
  if (failed.length) {
    lines.push('', 'Échecs :')
    for (const f of failed) lines.push(`  • ${f.id} — ${f.error}`)
  }

  // Always log a run that fired or failed. For a run that ONLY suppressed (common on
  // the every-2-min drain of a throttled rule), throttle the log so the history
  // stays readable while still surfacing that traffic is being held back.
  const onlySuppressed = fired.length === 0 && failed.length === 0 && suppressed.length > 0
  if (!onlySuppressed || shouldLogSuppressionOnly(rule.id, guard?.config?.windowMin || 60)) {
    logRuleRun(rule.id, {
      status: failed.length > 0 ? 'error' : 'success',
      result: lines.join('\n'),
      error: failed.length > 0 ? `${failed.length} tir(s) en échec` : null,
      duration_ms: Date.now() - started,
      triggerData: {
        candidates: candidates.length,
        fired: fired.length,
        deferred,
        suppressed: suppressed.length,
      },
    })
  }

  return {
    candidates: candidates.length,
    fired: fired.length,
    failed: failed.length,
    deferred,
    suppressed: suppressed.length,
  }
}

// --- Deferred-candidate queue (backpressure) -------------------------------

function enqueueDeferred(automationId, erpTable, ids) {
  if (!ids || !ids.length) return
  const ins = db.prepare(`
    INSERT OR IGNORE INTO automation_deferred_candidates (automation_id, record_table, record_id)
    VALUES (?, ?, ?)
  `)
  db.transaction(list => { for (const id of list) ins.run(automationId, erpTable, id) })(ids)
}

function dequeueDeferred(automationId, erpTable, ids) {
  if (!ids || !ids.length) return
  const del = db.prepare(`
    DELETE FROM automation_deferred_candidates
    WHERE automation_id=? AND record_table=? AND record_id=?
  `)
  db.transaction(list => { for (const id of list) del.run(automationId, erpTable, id) })(ids)
}

/**
 * Drop queue entries that no longer belong there — records that already fired or
 * that no longer match the trigger predicate (e.g. their status changed). Keeps
 * the depth gauge honest and prevents permanently-stuck rows from inflating it.
 */
function reconcileDeferredQueue(rule, erpTable) {
  const queued = db.prepare(`
    SELECT record_id FROM automation_deferred_candidates
    WHERE automation_id=? AND record_table=?
  `).all(rule.id, erpTable).map(r => r.record_id)
  if (!queued.length) return
  let stillPending
  try {
    const { predicate, params } = buildTriggerPredicate(rule.trigger_config)
    const ph = queued.map(() => '?').join(',')
    const sql = `
      SELECT t.id FROM ${erpTable} t
      WHERE (${predicate}) AND t.id IN (${ph})
        AND NOT EXISTS (
          SELECT 1 FROM automation_rule_fires f
          WHERE f.automation_id=? AND f.record_table=? AND f.record_id=t.id
        )
    `
    const rows = db.prepare(sql).all(...params, ...queued, rule.id, erpTable)
    stillPending = new Set(rows.map(r => r.id))
  } catch {
    return // predicate unbuildable (mid-edit) — leave the queue untouched
  }
  const stale = queued.filter(id => !stillPending.has(id))
  dequeueDeferred(rule.id, erpTable, stale)
}

/**
 * Load an active field_rule in the admin-facing shape, or null if it's missing,
 * inactive, soft-deleted, or has malformed JSON / an invalid erp_table.
 */
function loadFieldRule(automationId) {
  const r = db.prepare(`
    SELECT id, name, trigger_config, action_type, action_config
    FROM automations
    WHERE id=? AND kind='field_rule' AND active=1 AND deleted_at IS NULL
  `).get(automationId)
  if (!r) return null
  try {
    const tc = JSON.parse(r.trigger_config || '{}')
    if (!IDENT_RE.test(tc.erp_table || '')) return null
    return {
      id: r.id,
      name: r.name,
      trigger_config: tc,
      action_type: r.action_type,
      action_config: JSON.parse(r.action_config || '{}'),
    }
  } catch {
    return null
  }
}

/**
 * Drain one automation's deferred queue by one batch: reconcile stale entries,
 * then re-evaluate the rule as a full sync — which dispatches up to CANDIDATE_CAP
 * matches (clearing them from the queue) and re-parks the next slice of overflow.
 * Returns { fired, depth } where depth is the queue size after the pass.
 */
export async function drainDeferredForAutomation(automationId) {
  const rule = loadFieldRule(automationId)
  if (!rule) {
    // Orphan / inactive / malformed — drop its queue so it stops being processed.
    db.prepare('DELETE FROM automation_deferred_candidates WHERE automation_id=?').run(automationId)
    return { fired: 0, depth: 0 }
  }
  const erpTable = rule.trigger_config.erp_table
  reconcileDeferredQueue(rule, erpTable)
  const out = await evaluateOne(rule, { erpTable, tableId: null, changes: null })
  const depth = db.prepare(
    'SELECT COUNT(*) AS n FROM automation_deferred_candidates WHERE automation_id=?'
  ).get(automationId).n
  return { fired: out?.fired || 0, depth, candidates: out?.candidates || 0 }
}

/**
 * Background drain — one batch per automation that currently has deferred
 * candidates. Wired to a cron in automationScheduler.js. Safe no-op when the
 * feature is off or the queue is empty.
 */
export async function drainDeferredCandidates({ maxAutomations = 100 } = {}) {
  if (!FEATURE_ENABLED()) return { automations: 0, fired: 0 }
  const autoIds = db.prepare(
    'SELECT DISTINCT automation_id FROM automation_deferred_candidates'
  ).all().map(r => r.automation_id)
  let firedTotal = 0
  let processed = 0
  for (const autoId of autoIds.slice(0, maxAutomations)) {
    try {
      const out = await drainDeferredForAutomation(autoId)
      firedTotal += out.fired
      processed++
    } catch (e) {
      console.error(`Field-rule drain error (${autoId}):`, e.message)
    }
  }
  return { automations: processed, fired: firedTotal }
}

function resolveAirtableFieldId(erpTable, column) {
  const row = db.prepare(`
    SELECT airtable_field_id FROM airtable_field_mappings
    WHERE erp_table=? AND column_name=? AND airtable_field_id NOT LIKE 'webhook_%'
    LIMIT 1
  `).get(erpTable, column)
  return row?.airtable_field_id || null
}

function buildCandidateQuery(rule, erpTable, recordId = null) {
  const tableCols = db.prepare(`PRAGMA table_info(${erpTable})`).all().map(c => c.name)
  const hasCompany = tableCols.includes('company_id')
  const selectFrom = hasCompany
    ? `SELECT t.*, c.name AS company_name FROM ${erpTable} t LEFT JOIN companies c ON t.company_id = c.id`
    : `SELECT t.* FROM ${erpTable} t`
  const base = `
    ${selectFrom}
    WHERE `
  // Record-bounded mode (direct ERP write) restricts to a single id; sync mode
  // scans the table capped at CANDIDATE_CAP*4.
  const idClause = recordId ? ' AND t.id = ?' : ''
  const notFired = `
      AND NOT EXISTS (
        SELECT 1 FROM automation_rule_fires f
        WHERE f.automation_id=? AND f.record_table=? AND f.record_id=t.id
      )
    LIMIT ${CANDIDATE_CAP * 4}
  `
  const { predicate, params } = buildTriggerPredicate(rule.trigger_config)
  const bound = recordId
    ? [...params, recordId, rule.id, erpTable]
    : [...params, rule.id, erpTable]
  return {
    sql: `${base} ${predicate}${idClause} ${notFired}`,
    params: bound,
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
    `SELECT column_name FROM airtable_field_mappings WHERE erp_table=?
     UNION SELECT column_name FROM custom_fields WHERE erp_table=? AND deleted_at IS NULL AND kind='data'`
  ).all(erpTable, erpTable)) s.add(r.column_name)
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
  if (!erpTable || !IDENT_RE.test(erpTable)) {
    throw new Error(`erp_table invalide: ${erpTable}`)
  }
  const cols = triggerColumns(tc)
  if (!cols.length) throw new Error('Aucune colonne de déclencheur')
  for (const c of cols) {
    if (!IDENT_RE.test(c)) throw new Error(`column invalide: ${c}`)
  }
  const tableCols = db.prepare(`PRAGMA table_info(${erpTable})`).all().map(c => c.name)
  for (const c of cols) {
    if (!tableCols.includes(c)) throw new Error(`Colonne inexistante: ${erpTable}.${c}`)
  }

  const hasCompany = tableCols.includes('company_id')
  const selectFrom = hasCompany
    ? `SELECT t.*, c.name AS company_name FROM ${erpTable} t LEFT JOIN companies c ON t.company_id = c.id`
    : `SELECT t.* FROM ${erpTable} t`
  const { predicate, params } = buildTriggerPredicate(tc)
  const sql = `${selectFrom} WHERE ${predicate} LIMIT 200`

  const candidates = db.prepare(sql).all(...params)
  const firedIds = new Set(
    db.prepare('SELECT record_id FROM automation_rule_fires WHERE automation_id=?')
      .all(rule.id)
      .map(r => r.record_id)
  )
  const appUrl = APP_URL

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

/**
 * Render a field rule's action_config against ONE specific record, chosen by id.
 * Unlike dryRunFieldRule (which only sees records matching the trigger), this
 * lets the preview UI render the email on any record of the target table — so
 * the user can verify the interpolated subject/body before activating the rule.
 *
 * Returns { id, label, rendered, error, matches_trigger } or null if the record
 * does not exist. `matches_trigger` tells the UI whether this record would
 * actually fire the rule today.
 */
export function previewRuleForRecord(rule, recordId) {
  const tc = rule.trigger_config || {}
  const erpTable = tc.erp_table
  if (!erpTable || !IDENT_RE.test(erpTable)) {
    throw new Error(`erp_table invalide: ${erpTable}`)
  }
  const tableCols = db.prepare(`PRAGMA table_info(${erpTable})`).all().map(c => c.name)
  const hasCompany = tableCols.includes('company_id')
  const selectFrom = hasCompany
    ? `SELECT t.*, c.name AS company_name FROM ${erpTable} t LEFT JOIN companies c ON t.company_id = c.id`
    : `SELECT t.* FROM ${erpTable} t`
  const row = db.prepare(`${selectFrom} WHERE t.id = ?`).get(recordId)
  if (!row) return null
  row.app_url = APP_URL

  // Does this record match the trigger predicate? (informational only)
  let matchesTrigger = false
  try {
    const { predicate, params } = buildTriggerPredicate(tc)
    const m = db.prepare(`${selectFrom} WHERE (${predicate}) AND t.id = ?`).get(...params, recordId)
    matchesTrigger = !!m
  } catch { /* predicate may be unbuildable mid-edit — treat as non-matching */ }

  const label = row.title || row.name || row.company_name || row.id
  try {
    const rendered = renderActionConfig(rule.action_config, row, erpTable)
    return { id: row.id, label, rendered, error: null, matches_trigger: matchesTrigger }
  } catch (e) {
    return { id: row.id, label, rendered: null, error: e.message, matches_trigger: matchesTrigger }
  }
}

/**
 * Load every active field rule (all tables) whose op is `date_offset`, in the
 * admin-facing shape consumed by evaluateOne. Skips rows with malformed JSON.
 */
function loadActiveDateRules() {
  const rows = db.prepare(`
    SELECT id, name, trigger_config, action_type, action_config
    FROM automations
    WHERE kind='field_rule' AND active=1 AND deleted_at IS NULL
  `).all()
  const out = []
  for (const r of rows) {
    try {
      const tc = JSON.parse(r.trigger_config || '{}')
      if (tc.op !== 'date_offset') continue
      out.push({
        id: r.id,
        name: r.name,
        trigger_config: tc,
        action_type: r.action_type,
        action_config: JSON.parse(r.action_config || '{}'),
      })
    } catch {
      try { logRuleRun(r.id, { status: 'error', error: 'trigger_config/action_config JSON invalide', duration_ms: 0 }) } catch {}
    }
  }
  return out
}

/**
 * Daily scan — evaluates every active date-relative rule « as of today ».
 * Wired to a cron in automationScheduler.js. Dedup via automation_rule_fires
 * guarantees one fire per record even if the scan runs twice in a day.
 */
export async function evaluateDateOffsetRules() {
  if (!FEATURE_ENABLED()) return { rules: 0, fired: 0 }
  const rules = loadActiveDateRules()
  let firedTotal = 0
  for (const rule of rules) {
    const erpTable = rule.trigger_config.erp_table
    if (!IDENT_RE.test(erpTable || '')) continue
    const out = await evaluateOne(rule, { erpTable, tableId: null, changes: null })
    firedTotal += out?.fired || 0
  }
  return { rules: rules.length, fired: firedTotal }
}

/**
 * Run one date-relative rule immediately (admin « Lancer maintenant » button).
 * Live path: dispatches actions and records fires, exactly like the daily scan.
 * Throws if the rule is missing, inactive, or not a date_offset rule.
 */
export async function runDateOffsetRuleNow(automationId) {
  const r = db.prepare(`
    SELECT id, name, trigger_config, action_type, action_config
    FROM automations
    WHERE id=? AND kind='field_rule' AND active=1 AND deleted_at IS NULL
  `).get(automationId)
  if (!r) throw new Error('Règle introuvable ou inactive')
  const tc = JSON.parse(r.trigger_config || '{}')
  if (tc.op !== 'date_offset') throw new Error('Cette règle n\'est pas une règle de date relative')
  if (!IDENT_RE.test(tc.erp_table || '')) throw new Error(`erp_table invalide: ${tc.erp_table}`)
  const rule = {
    id: r.id,
    name: r.name,
    trigger_config: tc,
    action_type: r.action_type,
    action_config: JSON.parse(r.action_config || '{}'),
  }
  const out = await evaluateOne(rule, { erpTable: tc.erp_table, tableId: null, changes: null })
  return out || zeroSummary()
}

/**
 * Run a field rule's ACTION against ONE specific record, on demand — the engine
 * behind a « Button » custom field. Unlike every trigger-driven path this:
 *   - BYPASSES the trigger predicate entirely (the user explicitly clicked the
 *     button on that row — intent is unambiguous), and
 *   - does NOT dedup via automation_rule_fires (a button is repeatable), and
 *   - ignores the rule's active flag (a button-only automation is typically left
 *     inactive so it never fires on writes — only via the button).
 * It still renders action_config against the row and dispatches the adapter,
 * logging the run for visibility. Throws if the feature is off, the automation is
 * missing / not a field_rule / corrupt, the record doesn't exist, the table
 * doesn't match, or the adapter is unknown.
 */
export async function runRuleActionForRecord(automationId, erpTable, recordId) {
  if (!FEATURE_ENABLED()) throw new Error('Moteur de règles désactivé (FEATURE_FIELD_RULES)')
  if (!IDENT_RE.test(erpTable)) throw new Error(`erp_table invalide: ${erpTable}`)
  if (!recordId) throw new Error('record_id requis')

  const r = db.prepare(`
    SELECT id, name, trigger_config, action_type, action_config
    FROM automations
    WHERE id=? AND kind='field_rule' AND deleted_at IS NULL
  `).get(automationId)
  if (!r) throw new Error('Automation introuvable (doit être une règle de champ)')
  let tc, ac
  try { tc = JSON.parse(r.trigger_config || '{}'); ac = JSON.parse(r.action_config || '{}') }
  catch { throw new Error('Configuration de l\'automation corrompue (JSON invalide)') }
  if (tc.erp_table && tc.erp_table !== erpTable) {
    throw new Error(`L'automation cible « ${tc.erp_table} », pas « ${erpTable} »`)
  }
  const rule = { id: r.id, name: r.name, trigger_config: tc, action_type: r.action_type, action_config: ac }
  const adapter = ACTION_ADAPTERS[rule.action_type]
  if (!adapter) throw new Error(`Adaptateur inconnu: ${rule.action_type}`)

  const started = Date.now()
  const tableCols = db.prepare(`PRAGMA table_info(${erpTable})`).all().map(c => c.name)
  const hasCompany = tableCols.includes('company_id')
  const selectFrom = hasCompany
    ? `SELECT t.*, c.name AS company_name FROM ${erpTable} t LEFT JOIN companies c ON t.company_id = c.id`
    : `SELECT t.* FROM ${erpTable} t`
  const row = db.prepare(`${selectFrom} WHERE t.id = ?`).get(recordId)
  if (!row) throw new Error(`Enregistrement introuvable: ${recordId}`)
  row.app_url = APP_URL

  const label = row.title || row.name || row.company_name || row.id
  try {
    const rendered = renderActionConfig(rule.action_config, row, erpTable)
    await adapter({ rule, row, rendered })
    logRuleRun(rule.id, {
      status: 'success',
      result: `[Bouton] Action ${rule.action_type} déclenchée sur ${label} (${row.id})`,
      duration_ms: Date.now() - started,
      triggerData: { trigger: 'button', record_id: row.id },
    })
    return { ok: true, record_id: row.id, action_type: rule.action_type }
  } catch (e) {
    logRuleRun(rule.id, {
      status: 'error',
      error: e.message,
      duration_ms: Date.now() - started,
      triggerData: { trigger: 'button', record_id: row.id },
    })
    throw e
  }
}
