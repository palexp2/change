/**
 * Migration: Drop tenant_id from all tables and remove the tenants table.
 * SQLite >= 3.35.0 supports ALTER TABLE DROP COLUMN, but only when the column
 * is not part of a PRIMARY KEY, UNIQUE constraint, or index.
 * Tables with such constraints must be recreated.
 *
 * Usage: node src/migrate-drop-tenant.js
 */
import Database from 'better-sqlite3'
import { resolve } from 'path'
import dotenv from 'dotenv'

dotenv.config()

const DB_PATH = resolve(process.env.DATABASE_PATH || './data/erp.db')
const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = OFF') // Must be off during table recreation

console.log('SQLite version:', db.prepare('SELECT sqlite_version()').pluck().get())

// ── 1. Find all tables with tenant_id ──────────────────────────────────────

const allTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").pluck().all()
const tablesWithTenant = allTables.filter(name => {
  const cols = db.prepare(`PRAGMA table_info("${name}")`).all()
  return cols.some(c => c.name === 'tenant_id')
})
console.log(`\nFound ${tablesWithTenant.length} tables with tenant_id`)

// ── 2. Find tables that need recreation (tenant_id in UNIQUE/PK) ──────────

function needsRecreation(table) {
  // Check if tenant_id is in any unique index
  const indexes = db.prepare(`PRAGMA index_list("${table}")`).all()
  for (const idx of indexes) {
    if (!idx.unique) continue
    const cols = db.prepare(`PRAGMA index_info("${idx.name}")`).all()
    if (cols.some(c => c.name === 'tenant_id')) return true
  }
  // Check if tenant_id is part of primary key
  const cols = db.prepare(`PRAGMA table_info("${table}")`).all()
  const tenantCol = cols.find(c => c.name === 'tenant_id')
  if (tenantCol && tenantCol.pk > 0) return true
  return false
}

const simpleDropTables = []
const recreateTables = []

for (const table of tablesWithTenant) {
  if (needsRecreation(table)) {
    recreateTables.push(table)
  } else {
    simpleDropTables.push(table)
  }
}

console.log(`  Simple DROP COLUMN: ${simpleDropTables.length} tables`)
console.log(`  Need recreation: ${recreateTables.length} tables`)

// ── 3. Drop indexes that reference tenant_id ──────────────────────────────

console.log('\nDropping indexes with tenant_id...')
let indexesDropped = 0
for (const table of tablesWithTenant) {
  const indexes = db.prepare(`PRAGMA index_list("${table}")`).all()
  for (const idx of indexes) {
    // Skip auto-indexes (they'll be handled during table recreation)
    if (idx.name.startsWith('sqlite_autoindex_')) continue
    const cols = db.prepare(`PRAGMA index_info("${idx.name}")`).all()
    if (cols.some(c => c.name === 'tenant_id')) {
      db.prepare(`DROP INDEX IF EXISTS "${idx.name}"`).run()
      indexesDropped++
    }
  }
}
console.log(`  ${indexesDropped} indexes dropped`)

// ── 4. Simple DROP COLUMN for tables without UNIQUE constraints ───────────

console.log('\nDrop column (simple)...')
for (const table of simpleDropTables) {
  try {
    db.prepare(`ALTER TABLE "${table}" DROP COLUMN tenant_id`).run()
    process.stdout.write('.')
  } catch (e) {
    console.error(`\n  ❌ ${table}: ${e.message}`)
  }
}
console.log(` ${simpleDropTables.length} done`)

// ── 5. Recreate tables that have tenant_id in UNIQUE/PK ──────────────────

console.log('\nRecreating tables with tenant_id in constraints...')
for (const table of recreateTables) {
  try {
    // Get current CREATE TABLE statement
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").pluck().get(table)
    if (!sql) { console.error(`  ❌ ${table}: no CREATE TABLE found`); continue }

    // Get columns (excluding tenant_id)
    const cols = db.prepare(`PRAGMA table_info("${table}")`).all()
    const keepCols = cols.filter(c => c.name !== 'tenant_id').map(c => `"${c.name}"`)

    if (keepCols.length === 0) { console.error(`  ❌ ${table}: no columns left`); continue }

    // Strategy: rename old → copy data → drop old → rename new
    const tmpName = `_tmp_${table}`

    // Build new CREATE TABLE by modifying the original SQL
    // Remove tenant_id from column list and constraints
    let newSql = sql
      // Remove tenant_id column definition
      .replace(/,?\s*tenant_id\s+TEXT[^,)]*(?:REFERENCES[^,)]*)?/gi, '')
      .replace(/,?\s*"?tenant_id"?\s+TEXT[^,)]*(?:REFERENCES[^,)]*)?/gi, '')
      // Remove tenant_id from UNIQUE constraints
      .replace(/tenant_id\s*,\s*/g, '')
      .replace(/,\s*tenant_id/g, '')
      // Remove tenant_id from PRIMARY KEY definitions
      .replace(/tenant_id\s*,\s*/g, '')
      // Fix any double commas or leading/trailing commas in constraint lists
      .replace(/\(\s*,/g, '(')
      .replace(/,\s*\)/g, ')')
      .replace(/,,+/g, ',')

    // Replace table name with tmp name
    newSql = newSql.replace(`CREATE TABLE ${table}`, `CREATE TABLE "${tmpName}"`)
                   .replace(`CREATE TABLE "${table}"`, `CREATE TABLE "${tmpName}"`)
                   .replace(`CREATE TABLE IF NOT EXISTS ${table}`, `CREATE TABLE "${tmpName}"`)
                   .replace(`CREATE TABLE IF NOT EXISTS "${table}"`, `CREATE TABLE "${tmpName}"`)

    db.exec(`DROP TABLE IF EXISTS "${tmpName}"`)
    db.exec(newSql)
    db.exec(`INSERT INTO "${tmpName}" (${keepCols.join(',')}) SELECT ${keepCols.join(',')} FROM "${table}"`)
    db.exec(`DROP TABLE "${table}"`)
    db.exec(`ALTER TABLE "${tmpName}" RENAME TO "${table}"`)

    console.log(`  ✅ ${table}`)
  } catch (e) {
    console.error(`  ❌ ${table}: ${e.message}`)
  }
}

// ── 6. Drop the tenants table ─────────────────────────────────────────────

console.log('\nDropping tenants table...')
db.exec('DROP TABLE IF EXISTS tenants')
console.log('  ✅ tenants table dropped')

// ── 7. Verify ─────────────────────────────────────────────────────────────

console.log('\nVerification...')
let remaining = 0
for (const name of allTables) {
  try {
    const cols = db.prepare(`PRAGMA table_info("${name}")`).all()
    if (cols.some(c => c.name === 'tenant_id')) {
      console.log(`  ⚠️  ${name} still has tenant_id`)
      remaining++
    }
  } catch {} // table might have been dropped
}

if (remaining === 0) {
  console.log('  ✅ All tenant_id columns removed successfully!')
} else {
  console.log(`  ⚠️  ${remaining} table(s) still have tenant_id`)
}

db.pragma('foreign_keys = ON')
console.log('\n🎉 Migration complete!')
