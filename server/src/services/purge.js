import db from '../db/database.js'

const TABLES_WITH_SOFT_DELETE = [
  'base_tables',
  'base_fields',
  'base_records',
  'base_views',
  'automations',
  'base_interfaces',
  'base_interface_pages',
]

const RETENTION_DAYS = 30

export function runPurge() {
  let total = 0
  for (const table of TABLES_WITH_SOFT_DELETE) {
    try {
      const result = db.prepare(
        `DELETE FROM ${table} WHERE deleted_at IS NOT NULL AND deleted_at < datetime('now', '-${RETENTION_DAYS} days')`
      ).run()
      total += result.changes
    } catch (err) {
      console.warn(`[purge] Skipped ${table}:`, err.message)
    }
  }
  if (total > 0) console.log(`[purge] Purged ${total} soft-deleted row(s) older than ${RETENTION_DAYS} days`)
}
