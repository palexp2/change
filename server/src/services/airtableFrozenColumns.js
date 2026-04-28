import db from '../db/database.js'

// Columns that must never be overwritten by Airtable sync. Stored per erp_table.
// Returns a Set<string> of frozen column names for the given ERP table.
export function getFrozenColumns(erpTable) {
  const rows = db.prepare('SELECT column_name FROM airtable_frozen_columns WHERE erp_table=?').all(erpTable)
  return new Set(rows.map(r => r.column_name))
}

export function listFrozenColumns(erpTable) {
  return db.prepare('SELECT column_name, frozen_at, frozen_by FROM airtable_frozen_columns WHERE erp_table=? ORDER BY column_name').all(erpTable)
}

export function setFrozen(erpTable, column, frozen, userId = null) {
  if (frozen) {
    db.prepare(
      `INSERT INTO airtable_frozen_columns (erp_table, column_name, frozen_by)
       VALUES (?,?,?)
       ON CONFLICT(erp_table, column_name) DO UPDATE SET frozen_by=excluded.frozen_by,
         frozen_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`
    ).run(erpTable, column, userId)
  } else {
    db.prepare('DELETE FROM airtable_frozen_columns WHERE erp_table=? AND column_name=?').run(erpTable, column)
  }
}

// Given a list of (column, value) pairs, return the subset where column isn't frozen.
export function filterFrozen(erpTable, pairs) {
  const frozen = getFrozenColumns(erpTable)
  return pairs.filter(([col]) => !frozen.has(col))
}
