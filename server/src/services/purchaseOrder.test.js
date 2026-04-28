import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

import { insertPurchasesFromPo } from './purchaseOrder.js'

// Schéma minimal des tables touchées. Synchronisé à la main avec schema.js —
// si un test casse à cause d'une colonne absente, l'ajouter ici.
function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE products (id TEXT PRIMARY KEY, name_fr TEXT);
    CREATE TABLE purchases (
      id TEXT PRIMARY KEY,
      product_id TEXT,
      supplier TEXT,
      supplier_company_id TEXT,
      reference TEXT,
      order_date TEXT,
      qty_ordered INTEGER DEFAULT 0,
      qty_received INTEGER DEFAULT 0,
      unit_cost REAL DEFAULT 0,
      status TEXT DEFAULT 'Commandé',
      notes TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `)
  const seed = db.prepare('INSERT INTO products (id, name_fr) VALUES (?, ?)')
  seed.run('prod-A', 'Produit A')
  seed.run('prod-B', 'Produit B')
  return db
}

const baseP = (items) => ({
  po_number: 'PO-UNIT-1',
  date: '2026-04-22',
  supplier: 'Fournisseur X',
  items,
})

test('insertPurchasesFromPo — crée une ligne par item avec product_id', () => {
  const db = makeDb()
  const ids = insertPurchasesFromPo(db, baseP([
    { product_id: 'prod-A', product: 'A', qty: 3, rate: 10 },
    { product_id: 'prod-B', product: 'B', qty: 5, rate: 2.5 },
  ]), { supplierCompanyId: 'cmp-1', to: 'x@y.com' })

  assert.strictEqual(ids.length, 2)
  const rows = db.prepare('SELECT * FROM purchases ORDER BY product_id').all()
  assert.strictEqual(rows.length, 2)
  assert.strictEqual(rows[0].product_id, 'prod-A')
  assert.strictEqual(rows[0].qty_ordered, 3)
  assert.strictEqual(rows[0].unit_cost, 10)
  assert.strictEqual(rows[0].reference, 'PO-UNIT-1')
  assert.strictEqual(rows[0].order_date, '2026-04-22')
  assert.strictEqual(rows[0].supplier, 'Fournisseur X')
  assert.strictEqual(rows[0].supplier_company_id, 'cmp-1')
  assert.strictEqual(rows[0].status, 'Commandé')
  assert.match(rows[0].notes, /PO-UNIT-1/)
  assert.match(rows[0].notes, /x@y\.com/)
  assert.strictEqual(rows[1].product_id, 'prod-B')
  assert.strictEqual(rows[1].qty_ordered, 5)
  assert.strictEqual(rows[1].unit_cost, 2.5)
})

test('insertPurchasesFromPo — ignore les items sans product_id', () => {
  const db = makeDb()
  const ids = insertPurchasesFromPo(db, baseP([
    { product_id: 'prod-A', product: 'A', qty: 1, rate: 1 },
    { product: 'Ligne libre', qty: 2, rate: 5 }, // pas de product_id
    { product_id: null, product: 'Nullish', qty: 1, rate: 1 },
  ]))

  assert.strictEqual(ids.length, 1)
  const rows = db.prepare('SELECT * FROM purchases').all()
  assert.strictEqual(rows.length, 1)
  assert.strictEqual(rows[0].product_id, 'prod-A')
})

test('insertPurchasesFromPo — ignore un product_id qui ne référence pas un produit existant', () => {
  const db = makeDb()
  const ids = insertPurchasesFromPo(db, baseP([
    { product_id: 'prod-A', product: 'A', qty: 1, rate: 1 },
    { product_id: 'prod-ghost', product: 'Inexistant', qty: 2, rate: 3 },
  ]))

  assert.strictEqual(ids.length, 1)
  const rows = db.prepare('SELECT * FROM purchases').all()
  assert.deepStrictEqual(rows.map(r => r.product_id), ['prod-A'])
})

test('insertPurchasesFromPo — liste vide → aucun INSERT', () => {
  const db = makeDb()
  const ids = insertPurchasesFromPo(db, baseP([]))
  assert.deepStrictEqual(ids, [])
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM purchases').get().c, 0)
})

test('insertPurchasesFromPo — rollback si un INSERT échoue (transaction)', () => {
  const db = makeDb()
  // Forcer un crash en ajoutant une contrainte qui échouera sur la 2e ligne
  db.exec('CREATE UNIQUE INDEX ux_purchases_ref_prod ON purchases(reference, product_id)')
  assert.throws(() => {
    insertPurchasesFromPo(db, baseP([
      { product_id: 'prod-A', product: 'A', qty: 1, rate: 1 },
      { product_id: 'prod-A', product: 'Doublon', qty: 2, rate: 3 }, // violerait l'index
    ]))
  })
  // Aucune ligne ne doit persister
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM purchases').get().c, 0)
})
