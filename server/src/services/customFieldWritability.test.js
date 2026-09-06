// Règle d'éditabilité unique des champs personnalisés (customFieldWritability).
//
// Une valeur est éditable ⟺ le champ appartient à l'ERP : champ natif/perso,
// champ Airtable dont l'import est coupé (import_disabled=1) ou sans mapping
// actif, ou champ Airtable en sens 'push'/'both'. Un champ Airtable en 'pull'
// avec import actif est en LECTURE SEULE (toute écriture ERP serait écrasée au
// prochain sync — perte silencieuse, le bug que cette règle ferme).

import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'
import assert from 'node:assert/strict'

// DB jetable — n'ouvre jamais la vraie erp.db.
process.env.DATABASE_PATH = join(tmpdir(), `erp-test-cf-writability-${process.pid}.db`)

const db = (await import('../db/database.js')).default
// schema.js n'est pas exécuté en test : on recrée les tables utilisées.
db.exec(`CREATE TABLE IF NOT EXISTS custom_fields (
  id TEXT PRIMARY KEY,
  erp_table TEXT NOT NULL,
  name TEXT NOT NULL,
  column_name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'text',
  decimals INTEGER,
  kind TEXT NOT NULL DEFAULT 'data',
  source TEXT NOT NULL DEFAULT 'native',
  deleted_at TEXT
)`)
db.exec(`CREATE TABLE IF NOT EXISTS airtable_field_mappings (
  id TEXT PRIMARY KEY,
  module TEXT NOT NULL,
  erp_table TEXT NOT NULL,
  airtable_field_id TEXT,
  airtable_field_name TEXT,
  column_name TEXT NOT NULL,
  import_disabled INTEGER DEFAULT 0
)`)
db.exec(`CREATE TABLE IF NOT EXISTS airtable_field_directions (
  module TEXT NOT NULL,
  field_key TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'both',
  PRIMARY KEY (module, field_key)
)`)

const { getWritableCustomColumns, refusedAirtablePullKeys, isColumnWritable, AIRTABLE_PULL_EDIT_ERROR } =
  await import('./customFieldWritability.js')
const { setFieldDirection, dynamicDirectionKey } = await import('./airtableWriteback.js')

// `purchases` appartient au module write-back 'achats' — le sens des champs
// dynamiques y est configurable (clé dyn:<colonne>).
const TABLE = 'purchases'

let seq = 0
function addField({ column, source = 'native', kind = 'data', mapped = false, importDisabled = 0 }) {
  db.prepare(`
    INSERT INTO custom_fields (id, erp_table, name, column_name, type, kind, source)
    VALUES (?, ?, ?, ?, 'text', ?, ?)
  `).run(`cf${++seq}`, TABLE, column, column, kind, source)
  if (mapped) {
    db.prepare(`
      INSERT INTO airtable_field_mappings (id, module, erp_table, airtable_field_id, airtable_field_name, column_name, import_disabled)
      VALUES (?, 'achats', ?, ?, ?, ?, ?)
    `).run(`m${seq}`, TABLE, `fld${seq}`, column, column, importDisabled)
  }
}

addField({ column: 'cf_native_ok' })                                             // perso ERP
addField({ column: 'cf_pull_refuse', source: 'airtable', mapped: true })          // Airtable pull (défaut)
addField({ column: 'cf_both_ok', source: 'airtable', mapped: true })              // Airtable both (override)
addField({ column: 'cf_push_ok', source: 'airtable', mapped: true })              // Airtable push (override)
addField({ column: 'cf_import_coupe_ok', source: 'airtable', mapped: true, importDisabled: 1 })
addField({ column: 'cf_sans_mapping_ok', source: 'airtable' })                    // import inexistant
addField({ column: 'cf_formule', kind: 'formula' })                              // virtuel — jamais dans la whitelist

setFieldDirection('achats', dynamicDirectionKey('cf_both_ok'), 'both')
setFieldDirection('achats', dynamicDirectionKey('cf_push_ok'), 'push')

test('champ perso (source native) : éditable', () => {
  const cols = getWritableCustomColumns(TABLE).map(c => c.column_name)
  assert.ok(cols.includes('cf_native_ok'))
})

test('champ Airtable en pull avec import actif : refusé', () => {
  const cols = getWritableCustomColumns(TABLE).map(c => c.column_name)
  assert.ok(!cols.includes('cf_pull_refuse'))
})

test('champ Airtable en both : éditable', () => {
  const cols = getWritableCustomColumns(TABLE).map(c => c.column_name)
  assert.ok(cols.includes('cf_both_ok'))
})

test('champ Airtable en push : éditable', () => {
  const cols = getWritableCustomColumns(TABLE).map(c => c.column_name)
  assert.ok(cols.includes('cf_push_ok'))
})

test('champ Airtable dont l’import est coupé : éditable', () => {
  const cols = getWritableCustomColumns(TABLE).map(c => c.column_name)
  assert.ok(cols.includes('cf_import_coupe_ok'))
})

test('champ Airtable sans mapping actif : éditable (import inexistant)', () => {
  const cols = getWritableCustomColumns(TABLE).map(c => c.column_name)
  assert.ok(cols.includes('cf_sans_mapping_ok'))
})

test('champ virtuel (formule) : jamais dans la whitelist d’update', () => {
  const cols = getWritableCustomColumns(TABLE).map(c => c.column_name)
  assert.ok(!cols.includes('cf_formule'))
})

test('module hors write-back : champ Airtable importé refusé même sans override de sens', () => {
  // `factures` n'a pas de module write-back → dynamicFieldDirection = 'pull' figé.
  assert.equal(
    isColumnWritable('factures', { column_name: 'montant_avant_taxes', source: 'airtable', mapping_id: 'm', import_disabled: 0 }),
    false
  )
})

test('refusedAirtablePullKeys : signale uniquement les clés pull présentes dans le body', () => {
  const body = { cf_pull_refuse: 'x', cf_both_ok: 'y', notes: 'z' }
  assert.deepEqual(refusedAirtablePullKeys(TABLE, body), ['cf_pull_refuse'])
  assert.deepEqual(refusedAirtablePullKeys(TABLE, { cf_both_ok: 'y' }), [])
  assert.deepEqual(refusedAirtablePullKeys(TABLE, null), [])
  assert.ok(AIRTABLE_PULL_EDIT_ERROR.includes('Airtable'))
})
