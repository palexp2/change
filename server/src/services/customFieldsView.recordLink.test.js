// `recordLinkTargetOf` : quelle table ERP est visée par les valeurs d'une
// colonne. C'est ce qui rend cliquable un lookup qui rapatrie un champ lien.

import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'
import assert from 'node:assert/strict'

// DB jetable — n'ouvre jamais la vraie erp.db.
process.env.DATABASE_PATH = join(tmpdir(), `erp-test-recordlinktarget-${process.pid}.db`)

const db = (await import('../db/database.js')).default
db.exec(`CREATE TABLE IF NOT EXISTS companies (id TEXT PRIMARY KEY, name TEXT)`)
db.exec(`CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  company_id TEXT REFERENCES companies(id),   -- FK formelle
  contact_id TEXT,                            -- FK par heuristique de nom
  notes TEXT,
  entreprise TEXT                             -- champ lien Airtable
)`)
db.exec(`CREATE TABLE IF NOT EXISTS custom_fields (
  id TEXT PRIMARY KEY, erp_table TEXT, column_name TEXT, options TEXT, deleted_at TEXT
)`)
db.exec(`CREATE TABLE IF NOT EXISTS airtable_field_mappings (
  id TEXT PRIMARY KEY, erp_table TEXT, column_name TEXT, options TEXT
)`)

const { recordLinkTargetOf } = await import('./customFieldsView.js')

test('colonne FK déclarée → sa table cible', () => {
  assert.deepEqual(recordLinkTargetOf('orders', 'company_id'), { table: 'companies', link: true })
})

test('colonne en _id sans contrainte FK → table déduite du nom', () => {
  assert.deepEqual(recordLinkTargetOf('orders', 'contact_id'), { table: 'contacts', link: true })
})

test('colonne ordinaire → aucune référence', () => {
  assert.equal(recordLinkTargetOf('orders', 'notes'), null)
})

test('champ lien Airtable → la table cible réglée sur le mapping', () => {
  db.prepare('INSERT INTO custom_fields (id, erp_table, column_name, options) VALUES (?,?,?,?)')
    .run('cf1', 'orders', 'entreprise', '{"airtable_link_hint":true}')
  db.prepare('INSERT INTO airtable_field_mappings (id, erp_table, column_name, options) VALUES (?,?,?,?)')
    .run('m1', 'orders', 'entreprise', '{"link_target_table":"companies"}')
  assert.deepEqual(recordLinkTargetOf('orders', 'entreprise'), { table: 'companies', link: true })
})

test('champ lien Airtable sans table cible → référence sans indice (record IDs bruts)', () => {
  db.prepare('UPDATE airtable_field_mappings SET options=? WHERE id=?').run('{}', 'm1')
  assert.deepEqual(recordLinkTargetOf('orders', 'entreprise'), { table: null, link: true })
})

test('table ou colonne au nom invalide → null, jamais d\'interpolation SQL', () => {
  assert.equal(recordLinkTargetOf('orders; DROP TABLE companies', 'company_id'), null)
  assert.equal(recordLinkTargetOf('orders', 'company_id) --'), null)
})
