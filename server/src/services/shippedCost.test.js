// Calcul des coûts sur une base jetable : les réglages Airtable et les
// lignes de production ne doivent pas déterminer le résultat des tests.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'erp-shipped-cost-'))
process.env.DATABASE_PATH = join(dir, 'test.db')
const db = (await import('../db/database.js')).default
const { computeShippedTotalCost, shippedCostSql, SHIPPED_COST_COLUMN } = await import('./shippedCost.js')
const { up: disableShippedCostImport } = await import('../db/migrations/012-shipped-cost-owned-by-erp.js')
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

db.exec(`
  CREATE TABLE products (id TEXT PRIMARY KEY, unit_cost REAL, cout_unitaire TEXT);
  CREATE TABLE order_items (id TEXT PRIMARY KEY, product_id TEXT, qty REAL,
    shipped_unit_cost REAL, cout_total_au_moment_de_l_envoi TEXT);
  CREATE TABLE serial_numbers (id TEXT PRIMARY KEY, serial TEXT, order_item_id TEXT,
    manufacture_value REAL, deleted_at TEXT);
  CREATE TABLE airtable_field_mappings (erp_table TEXT, column_name TEXT,
    import_disabled INTEGER, updated_at TEXT);
  INSERT INTO products VALUES ('piece', 2, '4.5'), ('fifo', 7, NULL);
  INSERT INTO order_items VALUES
    ('serialized', 'piece', 2, NULL, NULL),
    ('piece-cost', 'piece', 3, NULL, NULL),
    ('fifo-cost', 'fifo', 2, NULL, NULL),
    ('frozen', 'piece', 1, NULL, '99'),
    ('mixed', 'piece', 3, NULL, NULL);
  INSERT INTO serial_numbers VALUES
    ('s1', 'SN1', 'serialized', 12, NULL),
    ('s2', 'SN2', 'serialized', 18, NULL),
    ('s3', 'SN3', 'mixed', 10, NULL);
  INSERT INTO airtable_field_mappings VALUES
    ('order_items', 'cout_total_au_moment_de_l_envoi', 0, NULL),
    ('order_items', 'qty', 0, NULL);
`)

test('ligne inexistante → null', () => {
  assert.equal(computeShippedTotalCost('oi-inexistante-test'), null)
})

test('ligne sérialisée : total = Σ des valeurs de fabrication', () => {
  const row = db.prepare(`
    SELECT oi.id, oi.qty FROM order_items oi
    JOIN serial_numbers sn ON sn.order_item_id = oi.id
    WHERE sn.manufacture_value > 0 AND sn.deleted_at IS NULL
    GROUP BY oi.id
    HAVING COUNT(sn.id) = oi.qty
    LIMIT 1
  `).get()
  assert.ok(row, 'fixture sérialisée présente')
  const c = computeShippedTotalCost(row.id)
  const expected = db.prepare(
    'SELECT COALESCE(SUM(manufacture_value), 0) AS t FROM serial_numbers WHERE order_item_id = ? AND deleted_at IS NULL'
  ).get(row.id).t
  assert.equal(c.serial_count, row.qty)
  assert.equal(c.unserialized_qty, 0)
  assert.equal(c.basis, 'series')
  assert.equal(c.total, Math.round(expected * 100) / 100)
})

test('ligne sans numéro de série : total = quantité × coût de la pièce', () => {
  const row = db.prepare(`
    SELECT oi.id, oi.qty, p.unit_cost AS fifo, p.cout_unitaire AS cout_piece
    FROM order_items oi
    JOIN products p ON p.id = oi.product_id
    WHERE CAST(p.cout_unitaire AS REAL) > 0 AND oi.qty > 0
      AND NOT EXISTS (SELECT 1 FROM serial_numbers sn WHERE sn.order_item_id = oi.id)
    LIMIT 1
  `).get()
  assert.ok(row, 'fixture de coût présente')
  const c = computeShippedTotalCost(row.id)
  assert.equal(c.serial_count, 0)
  assert.equal(c.basis, 'cout_unitaire')
  assert.equal(c.unserialized_qty, row.qty)
  // Le coût de la pièce prime sur celui saisi sur la ligne de commande.
  assert.equal(c.unit_cost, Number(row.cout_piece))
  assert.equal(c.total, Math.round(row.qty * Number(row.cout_piece) * 100) / 100)
})

test('coût de la pièce : repli sur le coût unitaire FIFO quand « Cout unitaire » est vide', () => {
  const row = db.prepare(`
    SELECT oi.id, p.unit_cost AS fifo FROM order_items oi
    JOIN products p ON p.id = oi.product_id
    WHERE p.unit_cost > 0 AND COALESCE(CAST(p.cout_unitaire AS REAL), 0) <= 0
      AND oi.qty > 0
      AND NOT EXISTS (SELECT 1 FROM serial_numbers sn WHERE sn.order_item_id = oi.id)
    LIMIT 1
  `).get()
  assert.ok(row, 'fixture de coût présente')
  assert.equal(computeShippedTotalCost(row.id).unit_cost, row.fifo)
})

test('shippedCostSql : coût gelé prioritaire, repli sur la même règle aux coûts du jour', () => {
  const sql = `SELECT ${shippedCostSql('oi')} AS cost FROM order_items oi WHERE oi.id = ?`
  const frozen = db.prepare(
    `SELECT id, ${SHIPPED_COST_COLUMN} AS c FROM order_items
     WHERE ${SHIPPED_COST_COLUMN} IS NOT NULL AND TRIM(${SHIPPED_COST_COLUMN}) != ''
       AND CAST(${SHIPPED_COST_COLUMN} AS REAL) > 0 LIMIT 1`
  ).get()
  if (frozen) {
    assert.equal(db.prepare(sql).get(frozen.id).cost, Number(frozen.c))
  }
  // Une ligne pas encore gelée doit valoir EXACTEMENT ce que le gel écrirait :
  // l'expression SQL et le calcul JS ne peuvent pas diverger.
  const notFrozen = db.prepare(
    `SELECT id FROM order_items
     WHERE (${SHIPPED_COST_COLUMN} IS NULL OR TRIM(${SHIPPED_COST_COLUMN}) = '')
       AND qty > 0 LIMIT 20`
  ).all()
  for (const row of notFrozen) {
    const expected = computeShippedTotalCost(row.id).total
    assert.equal(Math.round(db.prepare(sql).get(row.id).cost * 100) / 100, expected, `ligne ${row.id}`)
  }
})

test("la migration 012 coupe uniquement l'import du coût figé et reste idempotente", () => {
  assert.equal(disableShippedCostImport(db).mappings_disabled, 1)
  const mapping = db.prepare(
    'SELECT import_disabled FROM airtable_field_mappings WHERE erp_table = ? AND column_name = ?'
  ).get('order_items', SHIPPED_COST_COLUMN)
  assert.equal(mapping.import_disabled, 1, 'le sync Airtable ne doit plus écrire cette colonne')
  assert.equal(disableShippedCostImport(db).mappings_disabled, 0)
  assert.equal(db.prepare("SELECT import_disabled FROM airtable_field_mappings WHERE column_name = 'qty'").get().import_disabled, 0)
})
