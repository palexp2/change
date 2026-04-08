/**
 * Fix remaining tables that still have tenant_id after the first migration pass.
 * These tables have tenant_id in UNIQUE/PK constraints and need manual recreation.
 */
import Database from 'better-sqlite3'
import { resolve } from 'path'
import dotenv from 'dotenv'

dotenv.config()

const DB_PATH = resolve(process.env.DATABASE_PATH || './data/erp.db')
const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = OFF')

function recreate(table, newCreateSql) {
  // Get columns from new table definition (parse from SQL)
  const cols = db.prepare(`PRAGMA table_info("${table}")`).all()
  const keepCols = cols.filter(c => c.name !== 'tenant_id').map(c => `"${c.name}"`)

  const tmp = `_tmp_migrate_${table}`
  db.exec(`DROP TABLE IF EXISTS "${tmp}"`)
  db.exec(newCreateSql.replace(`CREATE TABLE ${table}`, `CREATE TABLE "${tmp}"`).replace(`CREATE TABLE "${table}"`, `CREATE TABLE "${tmp}"`))
  db.exec(`INSERT INTO "${tmp}" (${keepCols.join(',')}) SELECT ${keepCols.join(',')} FROM "${table}"`)
  db.exec(`DROP TABLE "${table}"`)
  db.exec(`ALTER TABLE "${tmp}" RENAME TO "${table}"`)
  console.log(`  ✅ ${table}`)
}

db.exec('BEGIN')

try {
  // users: UNIQUE(tenant_id, email) → UNIQUE(email)
  recreate('users', `CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin','sales','support','ops')),
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    ftp_username TEXT,
    phone_number TEXT,
    UNIQUE(email)
  )`)

  // companies: UNIQUE(tenant_id, quickbooks_vendor_id) → UNIQUE(quickbooks_vendor_id)
  // Get all columns except tenant_id
  const companyCols = db.prepare("PRAGMA table_info(companies)").all()
    .filter(c => c.name !== 'tenant_id')
    .map(c => `"${c.name}" ${c.type || 'TEXT'}${c.notnull ? ' NOT NULL' : ''}${c.dflt_value ? ` DEFAULT ${c.dflt_value}` : ''}`)
  // Just do simple ALTER TABLE DROP COLUMN + drop the unique index
  db.exec('DROP INDEX IF EXISTS idx_companies_qb_vendor')
  try {
    db.exec('ALTER TABLE companies DROP COLUMN tenant_id')
    console.log('  ✅ companies (simple drop after index removal)')
  } catch (e) {
    console.log('  ❌ companies:', e.message)
  }

  // connector_oauth: UNIQUE(tenant_id, connector, account_key) → UNIQUE(connector, account_key)
  recreate('connector_oauth', `CREATE TABLE connector_oauth (
    id TEXT PRIMARY KEY,
    connector TEXT NOT NULL,
    account_key TEXT,
    account_email TEXT,
    access_token TEXT,
    refresh_token TEXT,
    expiry_date INTEGER,
    metadata TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    scope TEXT,
    UNIQUE(connector, account_key)
  )`)

  // connector_config: PRIMARY KEY(tenant_id, connector, key) → we need a new PK
  recreate('connector_config', `CREATE TABLE connector_config (
    connector TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT,
    PRIMARY KEY(connector, key)
  )`)

  // Single-row config tables: tenant_id was PK → just make a simple rowid table
  const singleRowConfigs = [
    'drive_sync_state',
    'airtable_sync_config',
    'airtable_inventaire_config',
    'airtable_pieces_config',
    'airtable_orders_config',
    'airtable_achats_config',
    'airtable_billets_config',
    'airtable_serials_config',
    'airtable_envois_config',
  ]

  for (const table of singleRowConfigs) {
    try {
      const cols = db.prepare(`PRAGMA table_info("${table}")`).all()
      const keepCols = cols.filter(c => c.name !== 'tenant_id')
      const colDefs = keepCols.map(c => {
        let def = `"${c.name}" ${c.type || 'TEXT'}`
        if (c.dflt_value) def += ` DEFAULT ${c.dflt_value}`
        return def
      })
      const colNames = keepCols.map(c => `"${c.name}"`)
      const tmp = `_tmp_migrate_${table}`
      db.exec(`DROP TABLE IF EXISTS "${tmp}"`)
      db.exec(`CREATE TABLE "${tmp}" (${colDefs.join(', ')})`)
      db.exec(`INSERT INTO "${tmp}" (${colNames.join(',')}) SELECT ${colNames.join(',')} FROM "${table}"`)
      db.exec(`DROP TABLE "${table}"`)
      db.exec(`ALTER TABLE "${tmp}" RENAME TO "${table}"`)
      console.log(`  ✅ ${table}`)
    } catch (e) {
      console.log(`  ❌ ${table}: ${e.message}`)
    }
  }

  // table_view_configs: UNIQUE(tenant_id, table_name) → UNIQUE(table_name)
  {
    const cols = db.prepare("PRAGMA table_info(table_view_configs)").all()
    const keepCols = cols.filter(c => c.name !== 'tenant_id')
    const colNames = keepCols.map(c => `"${c.name}"`)
    const colDefs = keepCols.map(c => {
      let def = `"${c.name}" ${c.type || 'TEXT'}`
      if (c.pk) def += ' PRIMARY KEY'
      if (c.notnull && !c.pk) def += ' NOT NULL'
      if (c.dflt_value != null) {
        // Wrap expressions like datetime('now') in parens
        const dv = c.dflt_value
        def += ` DEFAULT ${dv.includes('(') && !dv.startsWith('(') ? `(${dv})` : dv}`
      }
      return def
    })
    const tmp = '_tmp_migrate_table_view_configs'
    db.exec(`DROP TABLE IF EXISTS "${tmp}"`)
    db.exec(`CREATE TABLE "${tmp}" (${colDefs.join(', ')}, UNIQUE(table_name))`)
    db.exec(`INSERT INTO "${tmp}" (${colNames.join(',')}) SELECT ${colNames.join(',')} FROM table_view_configs`)
    db.exec('DROP TABLE table_view_configs')
    db.exec(`ALTER TABLE "${tmp}" RENAME TO table_view_configs`)
    console.log('  ✅ table_view_configs')
  }

  // custom_field_defs: UNIQUE(tenant_id, entity_type, key)
  {
    const cols = db.prepare("PRAGMA table_info(custom_field_defs)").all()
    const keepCols = cols.filter(c => c.name !== 'tenant_id')
    const colNames = keepCols.map(c => `"${c.name}"`)
    const colDefs = keepCols.map(c => {
      let def = `"${c.name}" ${c.type || 'TEXT'}`
      if (c.pk) def += ' PRIMARY KEY'
      if (c.notnull && !c.pk) def += ' NOT NULL'
      if (c.dflt_value != null) {
        // Wrap expressions like datetime('now') in parens
        const dv = c.dflt_value
        def += ` DEFAULT ${dv.includes('(') && !dv.startsWith('(') ? `(${dv})` : dv}`
      }
      return def
    })
    const tmp = '_tmp_migrate_custom_field_defs'
    db.exec(`DROP TABLE IF EXISTS "${tmp}"`)
    db.exec(`CREATE TABLE "${tmp}" (${colDefs.join(', ')}, UNIQUE(entity_type, "key"))`)
    db.exec(`INSERT INTO "${tmp}" (${colNames.join(',')}) SELECT ${colNames.join(',')} FROM custom_field_defs`)
    db.exec('DROP TABLE custom_field_defs')
    db.exec(`ALTER TABLE "${tmp}" RENAME TO custom_field_defs`)
    console.log('  ✅ custom_field_defs')
  }

  // base_tables: UNIQUE(tenant_id, name)
  {
    const cols = db.prepare("PRAGMA table_info(base_tables)").all()
    const keepCols = cols.filter(c => c.name !== 'tenant_id')
    const colNames = keepCols.map(c => `"${c.name}"`)
    const colDefs = keepCols.map(c => {
      let def = `"${c.name}" ${c.type || 'TEXT'}`
      if (c.pk) def += ' PRIMARY KEY'
      if (c.notnull && !c.pk) def += ' NOT NULL'
      if (c.dflt_value != null) {
        // Wrap expressions like datetime('now') in parens
        const dv = c.dflt_value
        def += ` DEFAULT ${dv.includes('(') && !dv.startsWith('(') ? `(${dv})` : dv}`
      }
      return def
    })
    const tmp = '_tmp_migrate_base_tables'
    db.exec(`DROP TABLE IF EXISTS "${tmp}"`)
    db.exec(`CREATE TABLE "${tmp}" (${colDefs.join(', ')}, UNIQUE(name))`)
    db.exec(`INSERT INTO "${tmp}" (${colNames.join(',')}) SELECT ${colNames.join(',')} FROM base_tables`)
    db.exec('DROP TABLE base_tables')
    db.exec(`ALTER TABLE "${tmp}" RENAME TO base_tables`)
    console.log('  ✅ base_tables')
  }

  // nav_config: UNIQUE(tenant_id)
  {
    const cols = db.prepare("PRAGMA table_info(nav_config)").all()
    const keepCols = cols.filter(c => c.name !== 'tenant_id')
    const colNames = keepCols.map(c => `"${c.name}"`)
    const colDefs = keepCols.map(c => {
      let def = `"${c.name}" ${c.type || 'TEXT'}`
      if (c.pk) def += ' PRIMARY KEY'
      if (c.notnull && !c.pk) def += ' NOT NULL'
      if (c.dflt_value != null) {
        // Wrap expressions like datetime('now') in parens
        const dv = c.dflt_value
        def += ` DEFAULT ${dv.includes('(') && !dv.startsWith('(') ? `(${dv})` : dv}`
      }
      return def
    })
    const tmp = '_tmp_migrate_nav_config'
    db.exec(`DROP TABLE IF EXISTS "${tmp}"`)
    db.exec(`CREATE TABLE "${tmp}" (${colDefs.join(', ')})`)
    db.exec(`INSERT INTO "${tmp}" (${colNames.join(',')}) SELECT ${colNames.join(',')} FROM nav_config`)
    db.exec('DROP TABLE nav_config')
    db.exec(`ALTER TABLE "${tmp}" RENAME TO nav_config`)
    console.log('  ✅ nav_config')
  }

  // stripe_invoice_queue: UNIQUE(tenant_id, stripe_invoice_id)
  {
    const cols = db.prepare("PRAGMA table_info(stripe_invoice_queue)").all()
    const keepCols = cols.filter(c => c.name !== 'tenant_id')
    const colNames = keepCols.map(c => `"${c.name}"`)
    const colDefs = keepCols.map(c => {
      let def = `"${c.name}" ${c.type || 'TEXT'}`
      if (c.pk) def += ' PRIMARY KEY'
      if (c.notnull && !c.pk) def += ' NOT NULL'
      if (c.dflt_value != null) {
        // Wrap expressions like datetime('now') in parens
        const dv = c.dflt_value
        def += ` DEFAULT ${dv.includes('(') && !dv.startsWith('(') ? `(${dv})` : dv}`
      }
      return def
    })
    const tmp = '_tmp_migrate_stripe_invoice_queue'
    db.exec(`DROP TABLE IF EXISTS "${tmp}"`)
    db.exec(`CREATE TABLE "${tmp}" (${colDefs.join(', ')}, UNIQUE(stripe_invoice_id))`)
    db.exec(`INSERT INTO "${tmp}" (${colNames.join(',')}) SELECT ${colNames.join(',')} FROM stripe_invoice_queue`)
    db.exec('DROP TABLE stripe_invoice_queue')
    db.exec(`ALTER TABLE "${tmp}" RENAME TO stripe_invoice_queue`)
    console.log('  ✅ stripe_invoice_queue')
  }

  // stripe_qb_tax_mapping: UNIQUE(tenant_id, stripe_tax_id)
  {
    const cols = db.prepare("PRAGMA table_info(stripe_qb_tax_mapping)").all()
    const keepCols = cols.filter(c => c.name !== 'tenant_id')
    const colNames = keepCols.map(c => `"${c.name}"`)
    const colDefs = keepCols.map(c => {
      let def = `"${c.name}" ${c.type || 'TEXT'}`
      if (c.pk) def += ' PRIMARY KEY'
      if (c.notnull && !c.pk) def += ' NOT NULL'
      if (c.dflt_value != null) {
        // Wrap expressions like datetime('now') in parens
        const dv = c.dflt_value
        def += ` DEFAULT ${dv.includes('(') && !dv.startsWith('(') ? `(${dv})` : dv}`
      }
      return def
    })
    const tmp = '_tmp_migrate_stripe_qb_tax_mapping'
    db.exec(`DROP TABLE IF EXISTS "${tmp}"`)
    db.exec(`CREATE TABLE "${tmp}" (${colDefs.join(', ')}, UNIQUE(stripe_tax_id))`)
    db.exec(`INSERT INTO "${tmp}" (${colNames.join(',')}) SELECT ${colNames.join(',')} FROM stripe_qb_tax_mapping`)
    db.exec('DROP TABLE stripe_qb_tax_mapping')
    db.exec(`ALTER TABLE "${tmp}" RENAME TO stripe_qb_tax_mapping`)
    console.log('  ✅ stripe_qb_tax_mapping')
  }

  db.exec('COMMIT')
} catch (e) {
  db.exec('ROLLBACK')
  console.error('Migration failed, rolled back:', e.message)
  process.exit(1)
}

// Verify
console.log('\nVerification...')
const tables2 = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").pluck().all()
let remaining = 0
for (const name of tables2) {
  const cols = db.prepare(`PRAGMA table_info("${name}")`).all()
  if (cols.some(c => c.name === 'tenant_id')) {
    console.log(`  ⚠️  ${name} still has tenant_id`)
    remaining++
  }
}
if (remaining === 0) {
  console.log('  ✅ All tenant_id columns removed!')
} else {
  console.log(`  ⚠️  ${remaining} table(s) still have tenant_id`)
}

db.pragma('foreign_keys = ON')
console.log('\n🎉 Fix migration complete!')
