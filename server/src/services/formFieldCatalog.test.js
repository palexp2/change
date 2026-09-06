// Catalogue des champs proposables au formulaire d'ajout (formFieldCatalog).
//
// Ce que le catalogue doit garantir : « tous les champs de la table, sauf ceux
// sans saisie manuelle ». Les exclusions structurelles (formule, rollup, lookup,
// autonuméro, pièce jointe, champ lien, champ virtuel ERP) sont définitives ; un
// champ Airtable encore en sens import reste LISTÉ mais `writable: false`.

import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'
import assert from 'node:assert/strict'

// DB jetable — n'ouvre jamais la vraie erp.db.
process.env.DATABASE_PATH = join(tmpdir(), `erp-test-form-catalog-${process.pid}.db`)

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
  options TEXT,
  hidden INTEGER DEFAULT 0,
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
db.exec(`CREATE TABLE IF NOT EXISTS airtable_field_defs (
  id TEXT PRIMARY KEY,
  module TEXT,
  erp_table TEXT NOT NULL,
  column_name TEXT NOT NULL,
  field_type TEXT,
  options TEXT
)`)
db.exec(`CREATE TABLE IF NOT EXISTS airtable_field_directions (
  module TEXT NOT NULL,
  field_key TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'both',
  PRIMARY KEY (module, field_key)
)`)

const { formFieldCatalog } = await import('./formFieldCatalog.js')
const { setFieldDirection, dynamicDirectionKey } = await import('./airtableWriteback.js')

// `purchases` appartient au module write-back 'achats' — le sens des champs
// dynamiques y est configurable (clé dyn:<colonne>).
const TABLE = 'purchases'
const MODULE = 'achats'

let seq = 0
function addField({ column, label, type = 'text', kind = 'data', source = 'native', cfOptions = null, defType = null, defOptions = null, hidden = 0, deletedAt = null }) {
  const id = `cf${++seq}`
  db.prepare(`
    INSERT INTO custom_fields (id, erp_table, name, column_name, type, kind, source, options, hidden, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, TABLE, label || column, column, type, kind, source, cfOptions ? JSON.stringify(cfOptions) : null, hidden, deletedAt)
  if (source === 'airtable') {
    db.prepare(`
      INSERT INTO airtable_field_mappings (id, module, erp_table, airtable_field_id, airtable_field_name, column_name, import_disabled)
      VALUES (?, ?, ?, ?, ?, ?, 0)
    `).run(`m${seq}`, MODULE, TABLE, `fld${seq}`, column, column)
  }
  if (defType || defOptions) {
    db.prepare(`
      INSERT INTO airtable_field_defs (id, module, erp_table, column_name, field_type, options)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(`d${seq}`, MODULE, TABLE, column, defType || type, JSON.stringify(defOptions || {}))
  }
}

// Saisissables
addField({ column: 'cf_texte', label: 'Texte perso' })
addField({ column: 'cf_notes', label: 'Notes longues', type: 'long_text' })
addField({ column: 'cf_case', label: 'Case', type: 'checkbox' })
addField({ column: 'cf_choix', label: 'Choix', type: 'single_select', defType: 'single_select', defOptions: { choices: ['A', 'B'] } })
addField({ column: 'cf_montant', label: 'Montant', type: 'number', defType: 'number', defOptions: { format: 'currency' } })
addField({ column: 'cf_at_both', label: 'Airtable bidirectionnel', source: 'airtable', defOptions: {} })
// Listés mais verrouillés
addField({ column: 'cf_at_pull', label: 'Airtable import seul', source: 'airtable', defOptions: {} })
// Jamais proposés — pas de saisie manuelle
addField({ column: 'cf_formule_at', label: 'Formule Airtable', source: 'airtable', defOptions: { source: 'formula' } })
addField({ column: 'cf_rollup_at', label: 'Rollup Airtable', source: 'airtable', defType: 'number', defOptions: { source: 'rollup' } })
addField({ column: 'cf_lookup_at', label: 'Lookup Airtable', source: 'airtable', defOptions: { source: 'multipleLookupValues' } })
addField({ column: 'cf_piece_jointe', label: 'Pièce jointe', source: 'airtable', defOptions: { format: 'attachment' } })
addField({ column: 'cf_lien_at', label: 'Lien Airtable', source: 'airtable', defType: 'link', defOptions: { linked_table_id: 'tbl1' } })
addField({ column: 'autonumber', label: 'Autonumber', source: 'airtable', type: 'number', defType: 'number', defOptions: {} })
addField({ column: 'record_id', label: 'Record ID', source: 'airtable', defOptions: {} })
addField({ column: 'cf_formule_erp', label: 'Formule ERP', kind: 'formula' })
addField({ column: 'cf_rollup_erp', label: 'Rollup ERP', kind: 'rollup' })
addField({ column: 'cf_bouton', label: 'Bouton', kind: 'button' })
addField({ column: 'cf_supprime', label: 'Supprimé', deletedAt: '2026-01-01T00:00:00.000Z' })
addField({ column: 'cf_masque', label: 'Masqué', hidden: 1 })

setFieldDirection(MODULE, dynamicDirectionKey('cf_at_both'), 'both')

const catalog = formFieldCatalog(TABLE)
const byField = new Map(catalog.map(f => [f.field, f]))

test('champs saisissables : présents et proposables', () => {
  for (const col of ['cf_texte', 'cf_notes', 'cf_case', 'cf_choix', 'cf_montant', 'cf_at_both']) {
    assert.ok(byField.has(col), `${col} devrait être au catalogue`)
    assert.equal(byField.get(col).writable, true, `${col} devrait être proposable`)
  }
})

test('types de contrôle : long_text → textarea, select, currency', () => {
  assert.equal(byField.get('cf_notes').type, 'textarea')
  assert.equal(byField.get('cf_case').type, 'checkbox')
  assert.equal(byField.get('cf_choix').type, 'select')
  assert.deepEqual(byField.get('cf_choix').options, ['A', 'B'])
  assert.equal(byField.get('cf_montant').type, 'currency')
})

test('champ Airtable en import seul : listé mais verrouillé', () => {
  const f = byField.get('cf_at_pull')
  assert.ok(f, 'le champ doit rester visible dans la liste')
  assert.equal(f.writable, false)
  assert.ok(f.readonly_reason)
})

test('champs sans saisie manuelle : jamais au catalogue', () => {
  for (const col of [
    'cf_formule_at', 'cf_rollup_at', 'cf_lookup_at', 'cf_piece_jointe', 'cf_lien_at',
    'autonumber', 'record_id', 'cf_formule_erp', 'cf_rollup_erp', 'cf_bouton',
    'cf_supprime', 'cf_masque',
  ]) {
    assert.ok(!byField.has(col), `${col} ne devrait pas être proposé`)
  }
})

test('tri par libellé', () => {
  const labels = catalog.map(f => f.label)
  assert.deepEqual(labels, [...labels].sort((a, b) => a.localeCompare(b, 'fr')))
})

test('table sans registre : catalogue vide', () => {
  assert.deepEqual(formFieldCatalog('table_inexistante'), [])
})
