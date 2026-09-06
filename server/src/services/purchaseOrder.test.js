import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

import { insertPurchasesFromPo } from './purchaseOrder.js'

// Schéma minimal des tables touchées. Synchronisé à la main avec schema.js —
// si un test casse à cause d'une colonne absente, l'ajouter ici.
function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE products (id TEXT PRIMARY KEY, name_fr TEXT, unit_cost REAL DEFAULT 0);
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
  const seed = db.prepare('INSERT INTO products (id, name_fr, unit_cost) VALUES (?, ?, ?)')
  seed.run('prod-A', 'Produit A', 7.5)
  seed.run('prod-B', 'Produit B', 0)
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
  const { ids, skipped } = insertPurchasesFromPo(db, baseP([
    { product_id: 'prod-A', product: 'A', qty: 3, rate: 10 },
    { product_id: 'prod-B', product: 'B', qty: 5, rate: 2.5 },
  ]), { supplierCompanyId: 'cmp-1', to: 'x@y.com' })

  assert.strictEqual(ids.length, 2)
  assert.deepStrictEqual(skipped, { no_product: 0, zero_qty: 0, already_created: 0 })
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
  const { ids, skipped } = insertPurchasesFromPo(db, baseP([
    { product_id: 'prod-A', product: 'A', qty: 1, rate: 1 },
    { product: 'Ligne libre', qty: 2, rate: 5 }, // pas de product_id
    { product_id: null, product: 'Nullish', qty: 1, rate: 1 },
  ]))

  assert.strictEqual(ids.length, 1)
  assert.strictEqual(skipped.no_product, 2)
  const rows = db.prepare('SELECT * FROM purchases').all()
  assert.strictEqual(rows.length, 1)
  assert.strictEqual(rows[0].product_id, 'prod-A')
})

test('insertPurchasesFromPo — ignore un product_id qui ne référence pas un produit existant', () => {
  const db = makeDb()
  const { ids, skipped } = insertPurchasesFromPo(db, baseP([
    { product_id: 'prod-A', product: 'A', qty: 1, rate: 1 },
    { product_id: 'prod-ghost', product: 'Inexistant', qty: 2, rate: 3 },
  ]))

  assert.strictEqual(ids.length, 1)
  assert.strictEqual(skipped.no_product, 1)
  const rows = db.prepare('SELECT * FROM purchases').all()
  assert.deepStrictEqual(rows.map(r => r.product_id), ['prod-A'])
})

test('insertPurchasesFromPo — liste vide → aucun INSERT', () => {
  const db = makeDb()
  const { ids } = insertPurchasesFromPo(db, baseP([]))
  assert.deepStrictEqual(ids, [])
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM purchases').get().c, 0)
})

test('insertPurchasesFromPo — deux lignes du même produit → un seul achat, quantités additionnées', () => {
  const db = makeDb()
  const { ids } = insertPurchasesFromPo(db, baseP([
    { product_id: 'prod-A', product: 'A', qty: 2, rate: 10 },
    { product_id: 'prod-A', product: 'A (2e ligne)', qty: 3, rate: 5 },
  ]))

  assert.strictEqual(ids.length, 1)
  const row = db.prepare('SELECT * FROM purchases').get()
  assert.strictEqual(row.qty_ordered, 5)
  // Moyenne pondérée : (2×10 + 3×5) / 5 = 7
  assert.strictEqual(row.unit_cost, 7)
})

test('insertPurchasesFromPo — quantité 0 → pas d’achat', () => {
  const db = makeDb()
  const { ids, skipped } = insertPurchasesFromPo(db, baseP([
    { product_id: 'prod-A', product: 'A', qty: 0, rate: 10 },
    { product_id: 'prod-B', product: 'B', qty: 4, rate: 1 },
  ]))

  assert.strictEqual(ids.length, 1)
  assert.strictEqual(skipped.zero_qty, 1)
  assert.deepStrictEqual(db.prepare('SELECT product_id FROM purchases').all().map(r => r.product_id), ['prod-B'])
})

test('insertPurchasesFromPo — prix absent du PO → coût unitaire du produit', () => {
  const db = makeDb()
  insertPurchasesFromPo(db, baseP([
    { product_id: 'prod-A', product: 'A', qty: 2, rate: 0 },
    { product_id: 'prod-B', product: 'B', qty: 2, rate: 0 },
  ]))

  const rows = db.prepare('SELECT product_id, unit_cost FROM purchases ORDER BY product_id').all()
  assert.strictEqual(rows[0].unit_cost, 7.5) // repli sur products.unit_cost
  assert.strictEqual(rows[1].unit_cost, 0)   // produit sans coût connu
})

test('insertPurchasesFromPo — renvoi du même PO → aucun achat en double', () => {
  const db = makeDb()
  const po = baseP([
    { product_id: 'prod-A', product: 'A', qty: 3, rate: 10 },
    { product_id: 'prod-B', product: 'B', qty: 1, rate: 2 },
  ])
  const first = insertPurchasesFromPo(db, po)
  assert.strictEqual(first.ids.length, 2)

  const second = insertPurchasesFromPo(db, po)
  assert.deepStrictEqual(second.ids, [])
  assert.strictEqual(second.skipped.already_created, 2)
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM purchases').get().c, 2)
})

test('insertPurchasesFromPo — un autre PO du même produit reste créé', () => {
  const db = makeDb()
  insertPurchasesFromPo(db, baseP([{ product_id: 'prod-A', product: 'A', qty: 3, rate: 10 }]))
  const other = insertPurchasesFromPo(db, {
    ...baseP([{ product_id: 'prod-A', product: 'A', qty: 1, rate: 10 }]),
    po_number: 'PO-UNIT-2',
  })
  assert.strictEqual(other.ids.length, 1)
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM purchases').get().c, 2)
})

test('insertPurchasesFromPo — rollback si un INSERT échoue (transaction)', () => {
  const db = makeDb()
  // Forcer un crash sur la 2e ligne : un trigger qui refuse prod-B.
  db.exec(`
    CREATE TRIGGER refuse_b BEFORE INSERT ON purchases WHEN NEW.product_id = 'prod-B'
    BEGIN SELECT RAISE(ABORT, 'refusé'); END;
  `)
  assert.throws(() => {
    insertPurchasesFromPo(db, baseP([
      { product_id: 'prod-A', product: 'A', qty: 1, rate: 1 },
      { product_id: 'prod-B', product: 'B', qty: 2, rate: 3 },
    ]))
  })
  // Aucune ligne ne doit persister
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM purchases').get().c, 0)
})
