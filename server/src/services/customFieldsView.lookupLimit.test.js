// Lookup limité : un champ de référence qui porte PLUSIEURS enregistrements
// liés (champ lien Airtable) ne rapatrie que les n premiers / derniers.

import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'
import assert from 'node:assert/strict'

// DB jetable — n'ouvre jamais la vraie erp.db.
process.env.DATABASE_PATH = join(tmpdir(), `erp-test-lookuplimit-${process.pid}.db`)

const db = (await import('../db/database.js')).default
db.exec(`CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, envois TEXT)`)
db.exec(`CREATE TABLE IF NOT EXISTS shipments (
  id TEXT PRIMARY KEY, airtable_id TEXT, created_at TEXT, deleted_at TEXT
)`)
db.exec(`CREATE TABLE IF NOT EXISTS custom_fields (
  id TEXT PRIMARY KEY, erp_table TEXT, column_name TEXT, name TEXT,
  kind TEXT, type TEXT, result_type TEXT, options TEXT, sort_order INTEGER,
  created_at TEXT, deleted_at TEXT, view_error TEXT,
  formula_expr TEXT, lookup_fk TEXT, lookup_target_table TEXT, lookup_target_column TEXT,
  lookup_limit_n INTEGER, lookup_limit_dir TEXT,
  rollup_target_table TEXT, rollup_target_fk TEXT, rollup_target_column TEXT, rollup_agg TEXT,
  link_target_table TEXT, link_group_id TEXT, link_role TEXT, link_single INTEGER
)`)

db.prepare('INSERT INTO shipments (id, airtable_id, created_at) VALUES (?,?,?)').run('s1', 'recA', '2026-01-01')
db.prepare('INSERT INTO shipments (id, airtable_id, created_at) VALUES (?,?,?)').run('s2', 'recB', '2026-02-02')
db.prepare('INSERT INTO shipments (id, airtable_id, created_at) VALUES (?,?,?)').run('s3', 'recC', '2026-03-03')
const insOrder = db.prepare('INSERT INTO orders (id, envois) VALUES (?,?)')
insOrder.run('o1', '["recA","recB","recC"]')   // liste JSON (forme sync Airtable)
insOrder.run('o2', 'recB')                     // un seul lien
insOrder.run('o3', 'recA, recC')               // liste à virgules
insOrder.run('o4', null)                       // aucun lien
insOrder.run('o5', 's2')                       // id ERP plutôt que record ID

const setLimit = db.prepare('UPDATE custom_fields SET lookup_limit_n=?, lookup_limit_dir=? WHERE id=?')
db.prepare(`
  INSERT INTO custom_fields (id, erp_table, column_name, name, kind, result_type,
                             lookup_fk, lookup_target_table, lookup_target_column, sort_order)
  VALUES ('cf1','orders','cf_envoi','Envoi','lookup','date','envois','shipments','created_at',0)
`).run()

const { regenerateView, normalizeLookupLimit } = await import('./customFieldsView.js')

const valuesOf = () => Object.fromEntries(
  db.prepare('SELECT id, cf_envoi FROM orders_v ORDER BY id').all().map(r => [r.id, r.cf_envoi])
)

test('sans limite : le JOIN direct ne suit qu\'un lien simple', () => {
  regenerateView('orders')
  const v = valuesOf()
  assert.equal(v.o5, '2026-02-02')   // la valeur EST l'id de la cible
  assert.equal(v.o1, null)           // une liste ne joint rien
})

test('1 dernier enregistrement lié : valeur scalaire, ordre de la liste', () => {
  setLimit.run(1, 'last', 'cf1')
  regenerateView('orders')
  const v = valuesOf()
  assert.equal(v.o1, '2026-03-03')   // recC, dernier de la liste JSON
  assert.equal(v.o2, '2026-02-02')
  assert.equal(v.o3, '2026-03-03')   // recC, dernier de « recA, recC »
  assert.equal(v.o4, null)
  assert.equal(v.o5, '2026-02-02')   // id ERP reconnu comme record ID
})

test('1 premier enregistrement lié', () => {
  setLimit.run(1, 'first', 'cf1')
  regenerateView('orders')
  const v = valuesOf()
  assert.equal(v.o1, '2026-01-01')
  assert.equal(v.o3, '2026-01-01')
})

test('n > 1 : les valeurs sont listées dans l\'ordre demandé', () => {
  setLimit.run(2, 'first', 'cf1')
  regenerateView('orders')
  assert.equal(valuesOf().o1, '2026-01-01, 2026-02-02')
  setLimit.run(2, 'last', 'cf1')
  regenerateView('orders')
  assert.equal(valuesOf().o1, '2026-03-03, 2026-02-02')
})

test('enregistrement lié supprimé : ignoré', () => {
  db.prepare(`UPDATE shipments SET deleted_at='2026-09-09' WHERE id='s3'`).run()
  setLimit.run(1, 'last', 'cf1')
  regenerateView('orders')
  assert.equal(valuesOf().o1, '2026-02-02')
  db.prepare(`UPDATE shipments SET deleted_at=NULL WHERE id='s3'`).run()
})

test('valeur mal formée : la vue tient debout', () => {
  insOrder.run('o6', '["rec')      // JSON invalide
  insOrder.run('o7', 'rec"A')      // guillemet parasite
  setLimit.run(1, 'first', 'cf1')
  regenerateView('orders')
  const v = valuesOf()
  assert.equal(v.o6, null)
  assert.equal(v.o7, null)
})

test('limite invalide refusée', () => {
  assert.deepEqual(normalizeLookupLimit(null, null), { n: null, dir: null })
  assert.deepEqual(normalizeLookupLimit(3, 'last'), { n: 3, dir: 'last' })
  assert.deepEqual(normalizeLookupLimit(3, null), { n: 3, dir: 'first' })
  assert.throws(() => normalizeLookupLimit(0, 'first'), /invalide/)
  assert.throws(() => normalizeLookupLimit(999, 'first'), /invalide/)
  assert.throws(() => normalizeLookupLimit(1, 'DESC --'), /Sens invalide/)
})
