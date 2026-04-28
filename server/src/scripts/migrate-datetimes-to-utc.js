#!/usr/bin/env node
// One-shot migration : normalize all datetime columns to ISO UTC with Z suffix.
//
// Handles three input shapes :
//   1. "YYYY-MM-DD HH:MM:SS"         (SQLite datetime('now'), already UTC) → ISO Z
//   2. "YYYY-MM-DDTHH:MM:SS"         (naive ISO, assumed America/Toronto)   → UTC Z
//   3. "YYYY-MM-DDTHH:MM:SS.sssZ"    (already canonical)                    → skip
// Date-only "YYYY-MM-DD" rows are left untouched (business dates, no time).
//
// Idempotent : safe to re-run. Only updates rows whose value is not already Z.
// Dry-run by default. Pass --apply to execute.
//
// Usage :
//   node src/scripts/migrate-datetimes-to-utc.js            # dry run
//   node src/scripts/migrate-datetimes-to-utc.js --apply    # execute
//   DB_PATH=./copy.db node src/scripts/migrate-datetimes-to-utc.js --apply

import Database from 'better-sqlite3'
import { normalizeToUtcIso } from '../utils/datetime.js'

const DB_PATH = process.env.DB_PATH || './data/erp.db'
const APPLY = process.argv.includes('--apply')

const db = new Database(DB_PATH)

// Discover every TEXT column across user tables that currently holds at least
// one datetime-shaped value. We skip columns whose content is only date-only
// ("YYYY-MM-DD") since those are intentionally time-less business dates.
function discoverDatetimeColumns() {
  const targets = []
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
  ).all()

  for (const { name: table } of tables) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all()
    for (const col of cols) {
      const typeUpper = (col.type || '').toUpperCase()
      if (typeUpper && !typeUpper.includes('TEXT') && !typeUpper.includes('CHAR')) continue
      const field = col.name
      const quoted = `"${field.replace(/"/g, '""')}"`
      // Sample shapes
      const hasDatetime = db.prepare(
        `SELECT 1 FROM ${table}
         WHERE ${quoted} IS NOT NULL AND ${quoted} != ''
           AND (${quoted} LIKE '____-__-__ __:__:__%' OR ${quoted} LIKE '____-__-__T__:__:__%')
         LIMIT 1`,
      ).get()
      if (hasDatetime) targets.push({ table, field, quoted })
    }
  }
  return targets
}

function migrateColumn({ table, field, quoted }) {
  const rows = db.prepare(
    `SELECT rowid AS _rid, ${quoted} AS v FROM ${table}
     WHERE ${quoted} IS NOT NULL AND ${quoted} != ''
       AND ${quoted} NOT LIKE '%Z'`,
  ).all()

  let converted = 0
  let skipped = 0
  const errors = []
  const update = db.prepare(`UPDATE ${table} SET ${quoted} = ? WHERE rowid = ?`)
  const tx = db.transaction((items) => {
    for (const [newVal, rid] of items) update.run(newVal, rid)
  })
  const pending = []

  for (const { _rid, v } of rows) {
    // Leave date-only values alone
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) { skipped++; continue }
    const normalized = normalizeToUtcIso(v, 'America/Toronto')
    if (normalized == null) {
      errors.push({ rid: _rid, v })
      continue
    }
    if (normalized === v) { skipped++; continue }
    pending.push([normalized, _rid])
    converted++
  }

  if (APPLY && pending.length) tx(pending)

  return { converted, skipped, errors, sampled: rows.length }
}

function updateSchemaDefaults() {
  const beforeCount = db.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type IN ('table','index','trigger','view') AND sql LIKE '%datetime(''now'')%'",
  ).get().n
  if (!beforeCount) return { updated: 0 }

  if (!APPLY) return { updated: 0, pending: beforeCount }

  db.unsafeMode(true)
  db.exec("PRAGMA writable_schema = ON")
  const result = db.prepare(
    `UPDATE sqlite_master
     SET sql = REPLACE(sql, ?, ?)
     WHERE type IN ('table','index','trigger','view') AND sql LIKE '%' || ? || '%'`,
  ).run("datetime('now')", "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", "datetime('now')")
  db.exec("PRAGMA writable_schema = OFF")
  db.unsafeMode(false)

  const integrity = db.pragma('integrity_check', { simple: true })
  if (integrity !== 'ok') {
    throw new Error(`Integrity check failed after schema update: ${integrity}`)
  }
  return { updated: result.changes }
}

function main() {
  console.log(`→ Database: ${DB_PATH}`)
  console.log(`→ Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`)
  console.log()

  // Phase 1 : update table DEFAULTs so future inserts produce ISO Z
  const schema = updateSchemaDefaults()
  if (schema.pending) console.log(`Schema entries pending update: ${schema.pending}`)
  if (schema.updated) console.log(`Updated ${schema.updated} schema entries (DEFAULTs)`)
  console.log()

  // Phase 2 : convert existing row values to ISO Z
  const targets = discoverDatetimeColumns()
  console.log(`Discovered ${targets.length} datetime columns`)
  console.log()

  const summary = []
  let totalConverted = 0
  let totalSkipped = 0
  const allErrors = []

  for (const t of targets) {
    const r = migrateColumn(t)
    summary.push({ table: t.table, field: t.field, ...r, errors: r.errors.length })
    totalConverted += r.converted
    totalSkipped += r.skipped
    for (const e of r.errors) allErrors.push({ table: t.table, field: t.field, ...e })
  }

  console.table(summary.filter(s => s.converted > 0 || s.errors > 0))
  console.log()
  console.log(`Total converted: ${totalConverted}`)
  console.log(`Total skipped (date-only or already-Z): ${totalSkipped}`)
  console.log(`Total errors (unparseable): ${allErrors.length}`)
  if (allErrors.length) {
    console.log('First 10 errors:')
    for (const e of allErrors.slice(0, 10)) console.log('  ', e.table, e.field, e.rid, JSON.stringify(e.v))
  }
  if (!APPLY) console.log('\n(dry run — pass --apply to persist)')
}

main()
