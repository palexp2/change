// Lookup vers un champ « Attachement » : la cellule doit porter des
// descripteurs de fichiers OUVRABLES, donc marqués du champ et de
// l'enregistrement SOURCE (les fichiers appartiennent à la ligne liée, pas à la
// ligne affichée).

import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'
import assert from 'node:assert/strict'

// DB jetable — n'ouvre jamais la vraie erp.db.
process.env.DATABASE_PATH = join(tmpdir(), `erp-test-lookupattach-${process.pid}.db`)

const db = (await import('../db/database.js')).default
db.exec(`CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, product_id TEXT, produits TEXT)`)
db.exec(`CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY, airtable_id TEXT, cf_doc TEXT, name_fr TEXT, deleted_at TEXT
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

const PDF = { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee_notice.pdf', name: 'notice.pdf', size: 12, type: 'application/pdf' }
const IMG = { id: 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee_photo.png', name: 'photo.png', size: 34, type: 'image/png' }

const insProduct = db.prepare('INSERT INTO products (id, airtable_id, cf_doc) VALUES (?,?,?)')
insProduct.run('p1', 'recA', JSON.stringify([PDF, IMG]))
insProduct.run('p2', 'recB', 'pas du JSON')      // valeur héritée illisible
insProduct.run('p3', 'recC', null)               // aucun fichier
const insOrder = db.prepare('INSERT INTO orders (id, product_id, produits) VALUES (?,?,?)')
insOrder.run('o1', 'p1', '["recA","recC"]')
insOrder.run('o2', 'p2', 'recB')
insOrder.run('o3', 'p3', null)

// Le champ Attachement SOURCE, celui qui porte réellement les fichiers.
db.prepare(`
  INSERT INTO custom_fields (id, erp_table, column_name, name, kind, type, sort_order)
  VALUES ('fld-doc','products','cf_doc','Document','data','attachment',0)
`).run()
// Le lookup qui le rapatrie sur la commande.
db.prepare(`
  INSERT INTO custom_fields (id, erp_table, column_name, name, kind, result_type,
                             lookup_fk, lookup_target_table, lookup_target_column, sort_order)
  VALUES ('cf1','orders','cf_doc_produit','Document du produit','lookup','attachment',
          'product_id','products','cf_doc',0)
`).run()

const { regenerateView, inferLookupResultType } = await import('./customFieldsView.js')

const setLookup = db.prepare('UPDATE custom_fields SET lookup_fk=?, lookup_limit_n=?, lookup_limit_dir=? WHERE id=?')
const valuesOf = () => Object.fromEntries(
  db.prepare('SELECT id, cf_doc_produit FROM orders_v ORDER BY id').all().map(r => [r.id, r.cf_doc_produit])
)

test('le format d\'un lookup vers un champ Attachement est « attachment »', () => {
  assert.equal(inferLookupResultType('products', 'cf_doc'), 'attachment')
})

test('lien direct : chaque fichier porte son champ et son enregistrement source', () => {
  regenerateView('orders')
  const v = valuesOf()
  const files = JSON.parse(v.o1)
  assert.equal(files.length, 2)
  assert.deepEqual(files[0], { ...PDF, field_id: 'fld-doc', record_id: 'p1' })
  assert.equal(files[1].record_id, 'p1')
  // Une valeur illisible ou vide ne casse pas la vue et ne fabrique rien.
  assert.equal(v.o2, null)
  assert.equal(v.o3, null)
})

test('liste de liens : les fichiers des n enregistrements liés se fondent en un tableau', () => {
  setLookup.run('produits', 2, 'first', 'cf1')
  regenerateView('orders')
  const files = JSON.parse(valuesOf().o1)
  assert.equal(files.length, 2)                        // p1 en porte 2, p3 aucun
  assert.ok(files.every(f => f.record_id === 'p1' && f.field_id === 'fld-doc'))
})

test('un seul enregistrement lié : même enrichissement', () => {
  setLookup.run('produits', 1, 'first', 'cf1')
  regenerateView('orders')
  const v = valuesOf()
  assert.equal(JSON.parse(v.o1)[0].record_id, 'p1')
  assert.equal(v.o2, null)                             // JSON illisible → rien
})

test('lookup ordinaire : la valeur reste recopiée telle quelle', () => {
  db.prepare('UPDATE custom_fields SET lookup_target_column=?, result_type=? WHERE id=?')
    .run('name_fr', 'text', 'cf1')
  db.prepare('UPDATE products SET name_fr=? WHERE id=?').run('Régulateur', 'p1')
  setLookup.run('product_id', null, null, 'cf1')
  regenerateView('orders')
  assert.equal(valuesOf().o1, 'Régulateur')
})
