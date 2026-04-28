import db from '../db/database.js'

let _insertStmt

function getInsertStmt() {
  if (!_insertStmt) {
    _insertStmt = db.prepare(`
      INSERT INTO sync_log (module, trigger, status, records_modified, records_destroyed, error_message, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
  }
  return _insertStmt
}

/**
 * Log a sync execution.
 * @param {string} module - e.g. 'serials', 'orders', 'airtable'
 * @param {'webhook'|'manual'|'scheduled'} trigger
 * @param {{ status: 'success'|'error', modified?: number, destroyed?: number, error?: string, durationMs?: number }} result
 */
export function logSync(module, trigger, result) {
  try {
    getInsertStmt().run(
      module,
      trigger,
      result.status,
      result.modified || 0,
      result.destroyed || 0,
      result.error || null,
      result.durationMs || null,
    )
  } catch (e) {
    console.error('syncLog write error:', e.message)
  }
}

/** Delete logs older than 7 days. */
export function purgeSyncLogs() {
  try {
    const { changes } = db.prepare("DELETE FROM sync_log WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')").run()
    if (changes > 0) console.log(`🧹 sync_log: ${changes} old entries purged`)
  } catch (e) {
    console.error('syncLog purge error:', e.message)
  }
}
