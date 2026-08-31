// fieldRuleWatcher — universal trigger for declarative field_rule automations.
//
// Instead of instrumenting every write path of every table (fragile, and some
// tables like `factures` have no dedicated route), we tail the change_log: a
// trigger-populated journal of every mutation on the cached tables (see
// db/changeLog.js). For each new upsert on a watched table, we re-evaluate the
// field rules on that one record (bounded query, no table scan).
//
// Loop safety is structural: automation_rule_fires makes each (rule, record)
// pair fire at most once, so a script that writes a record — which itself lands
// in change_log — cannot cause that record's already-fired rules to fire again.
//
// Gated by FEATURE_FIELD_RULES; the watcher is never started when the flag is
// off, so it is zero-cost until the feature is switched on.

import db from '../db/database.js'
import { evaluateFieldRulesForRecord } from './fieldRuleEngine.js'
import { createChangeLogWatcher } from './changeLogWatcher.js'

// Must stay in sync with WRITABLE_TABLES in scriptSandbox.js.
export const WATCHED_TABLES = [
  'factures', 'products', 'orders', 'shipments', 'companies', 'contacts', 'serial_numbers',
]

const POLL_MS = 5000
const BATCH = 500

// Subset of WATCHED_TABLES that currently has at least one active rule. Lets the
// watcher skip records for tables nobody is watching. Returns null (falsy) when
// empty so the factory fast-forwards the cursor — enabling a rule later doesn't
// replay the whole 48h backlog.
function tablesWithActiveRules() {
  const rows = db.prepare(`
    SELECT trigger_config FROM automations
    WHERE kind='field_rule' AND active=1 AND deleted_at IS NULL
  `).all()
  const set = new Set()
  for (const r of rows) {
    try {
      const tc = JSON.parse(r.trigger_config || '{}')
      if (WATCHED_TABLES.includes(tc.erp_table)) set.add(tc.erp_table)
    } catch { /* malformed config surfaced elsewhere */ }
  }
  return set.size ? set : null
}

const watcher = createChangeLogWatcher({
  name: 'fieldRuleWatcher',
  intervalMs: POLL_MS,
  tables: WATCHED_TABLES,
  batchSize: BATCH,
  isEnabled: tablesWithActiveRules,
  onRows: async (rows, { advance, enabledState: active }) => {
    for (const row of rows) {
      advance(row.id)
      if (!active.has(row.table_name)) continue
      await evaluateFieldRulesForRecord({
        erpTable: row.table_name,
        recordId: row.record_id,
        changedColumns: null, // change_log doesn't store which columns changed
      })
    }
  },
  startLog: `started (poll ${POLL_MS}ms, tables: ${WATCHED_TABLES.join(', ')})`,
})

// One poll cycle. Exported for tests (deterministic, no timer).
export const pollOnce = watcher.pollOnce

export function startFieldRuleWatcher() { watcher.start() }
export function stopFieldRuleWatcher() { watcher.stop() }

// Test seam — set the cursor explicitly.
export function _setLastSeenId(n) { watcher.setLastSeenId(n) }
export function _getLastSeenId() { return watcher.getLastSeenId() }
