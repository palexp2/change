// Coût FIFO sur une base jetable : lots les plus récents en stock, lots sans
// prix exclus, prix douteux et stock sans achat signalés.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'erp-fifo-cost-'))
process.env.DATABASE_PATH = join(dir, 'test.db')
const db = (await import('../db/database.js')).default
const { computeFifo, applyFifo, productIdsForPurchase } = await import('./fifoCost.js')
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

db.exec(`
  CREATE TABLE products (id TEXT PRIMARY KEY, airtable_id TEXT, procurement_type TEXT, stock_qty REAL,
    unit_cost REAL, cout_unitaire TEXT, valeur_inventaire TEXT, deleted_at TEXT, updated_at TEXT);
  CREATE TABLE purchases (id TEXT PRIMARY KEY, airtable_id TEXT, at_id TEXT, nom_de_la_piece TEXT,
    quantite_commande TEXT, date_de_commande TEXT, created_at TEXT, cf_date_de_reception_complete TEXT,
    override_prix_unitaire_paye_cad TEXT, prix_unitaire_facture_cad TEXT, prix_unitaire_cad TEXT);
  CREATE TABLE product_opening_costs (product_id TEXT PRIMARY KEY, unit_cost REAL NOT NULL, set_by TEXT, set_at TEXT);
  CREATE TABLE purchase_price_approvals (purchase_id TEXT PRIMARY KEY, unit_price REAL NOT NULL, approved_by TEXT, approved_at TEXT);
  CREATE TABLE purchase_prices (airtable_id TEXT PRIMARY KEY, unit_price REAL, fetched_at TEXT);
  CREATE TABLE product_fifo (product_id TEXT PRIMARY KEY, cost REAL, qty REAL, uncovered REAL,
    layers TEXT, issues TEXT, issue_count INTEGER NOT NULL DEFAULT 0, computed_at TEXT, pushed_cost REAL);
  INSERT INTO products (id, airtable_id, procurement_type, stock_qty, unit_cost) VALUES
    ('p1', 'recP1', 'Acheté', 15, 1), ('p2', 'recP2', 'Acheté', 30, 0),
    ('fab', 'recF', 'Fabriqué', 5, 3), ('p0', 'recP0', 'Acheté', 0, 0);
  INSERT INTO purchases VALUES
    ('a1', 'recA1', 'LIA-1', '["recP1"]', '10', '2025-01-01', NULL, '1970-01-01', '2', NULL, NULL),
    ('a2', 'recA2', 'LIA-2', '["recP1"]', '10', '2025-06-01', NULL, '2025-06-05', NULL, '3', NULL),
    ('a3', 'recA3', 'LIA-3', '["recP1"]', '5',  '2025-09-01', NULL, NULL,         '9', NULL, NULL),
    ('b1', 'recB1', 'LIA-4', '["recP2"]', '10', '2025-01-01', NULL, '2025-01-02', '1', NULL, NULL),
    ('b2', 'recB2', 'LIA-5', '["recP2"]', '10', '2025-02-01', NULL, '2025-02-02', '1', NULL, NULL),
    ('b3', 'recB3', 'LIA-6', '["recP2"]', '10', '2025-03-01', NULL, '2025-03-02', NULL, NULL, NULL),
    ('c1', 'recC1', 'LIA-7', '["recP0"]', '4',  '2025-03-01', NULL, '2025-03-02', '6', NULL, NULL),
    ('f1', 'recF1', 'LIA-8', '["recF"]',  '4',  '2025-03-01', NULL, '2025-03-02', '6', NULL, NULL);
`)

test('stock = lots les plus récents reçus ; un achat non reçu ne compte pas', () => {
  const r = computeFifo('p1')
  // 10 × 3 $ (LIA-2, le plus récent reçu) + 5 × 2 $ (LIA-1) = 40 $ / 15
  assert.equal(r.cost, 2.6667)
  assert.deepEqual(r.layers.map(l => [l.at_id, l.qty_in_stock]), [['LIA-2', 10], ['LIA-1', 5]])
  assert.deepEqual(r.issues, [])
})

test('le prix relu dans Airtable passe avant les anciennes colonnes', () => {
  db.prepare("INSERT INTO purchase_prices VALUES ('recA2', 5, 'x')").run()
  assert.equal(computeFifo('p1').cost, 4) // (10 × 5 + 5 × 2) / 15
  db.prepare("DELETE FROM purchase_prices").run()
})

test('lot sans prix exclu de la moyenne et signalé', () => {
  const r = computeFifo('p2')
  assert.equal(r.cost, 1)
  assert.deepEqual(r.issues.map(i => i.kind), ['sans_prix'])
  // Marqué gratuit : compté à 0 $, plus d'alerte.
  db.prepare("INSERT INTO purchase_price_approvals VALUES ('b3', 0, NULL, NULL)").run()
  const free = computeFifo('p2')
  assert.equal(free.cost, 0.6667) // (10 × 0 + 10 × 1 + 10 × 1) / 30
  assert.deepEqual(free.issues, [])
  db.prepare("DELETE FROM purchase_price_approvals").run()
})

test('stock supérieur aux achats reçus : surplus au prix du plus ancien achat, sans alerte', () => {
  db.prepare("UPDATE products SET stock_qty = 25 WHERE id = 'p1'").run()
  const r = computeFifo('p1')
  assert.equal(r.uncovered, 5)
  assert.equal(r.cost, 2.4) // (10 × 3 + 10 × 2 + 5 × 2) / 25
  assert.deepEqual(r.issues, [])
  db.prepare("UPDATE products SET stock_qty = 15 WHERE id = 'p1'").run()
})

test('stock sans aucun achat avec prix : signalé', () => {
  db.prepare("UPDATE products SET stock_qty = 35 WHERE id = 'p2'").run()
  db.prepare("UPDATE purchases SET override_prix_unitaire_paye_cad = NULL WHERE id IN ('b1', 'b2')").run()
  assert.ok(computeFifo('p2').issues.some(i => i.kind === 'stock_sans_achat'))
  // Coût de départ saisi : le surplus est valorisé, plus d'alerte.
  db.prepare("INSERT INTO product_opening_costs VALUES ('p2', 4, NULL, NULL)").run()
  const r = computeFifo('p2')
  assert.ok(!r.issues.some(i => i.kind === 'stock_sans_achat'))
  assert.equal(r.cost, 4)
  db.prepare("DELETE FROM product_opening_costs").run()
  db.prepare("UPDATE purchases SET override_prix_unitaire_paye_cad = '1' WHERE id IN ('b1', 'b2')").run()
  db.prepare("UPDATE products SET stock_qty = 30 WHERE id = 'p2'").run()
})

test('prix très éloigné des autres lots signalé', () => {
  db.prepare("UPDATE purchases SET override_prix_unitaire_paye_cad = '30' WHERE id = 'a2'").run()
  const r = computeFifo('p1')
  assert.ok(r.issues.some(i => i.kind === 'prix_douteux' && i.at_id === 'LIA-2'))
  // Prix vérifié : l'alerte tombe… tant que le prix ne change pas.
  db.prepare("INSERT INTO purchase_price_approvals VALUES ('a2', 30, NULL, NULL)").run()
  const ok = computeFifo('p1')
  assert.ok(!ok.issues.some(i => i.at_id === 'LIA-2'))
  assert.equal(ok.layers.find(l => l.at_id === 'LIA-2').approved, true)
  db.prepare("UPDATE purchases SET override_prix_unitaire_paye_cad = '40' WHERE id = 'a2'").run()
  assert.ok(computeFifo('p1').issues.some(i => i.kind === 'prix_douteux' && i.at_id === 'LIA-2'))
  db.prepare("DELETE FROM purchase_price_approvals").run()
  db.prepare("UPDATE purchases SET override_prix_unitaire_paye_cad = NULL WHERE id = 'a2'").run()
})

test('stock nul : prix du dernier lot', () => {
  assert.equal(computeFifo('p0').cost, 6)
})

test("applyFifo écrit le coût seulement s'il change ; pièce fabriquée intouchée", () => {
  const r = applyFifo('p1')
  assert.equal(r.changed, true)
  const row = db.prepare("SELECT unit_cost, cout_unitaire, valeur_inventaire FROM products WHERE id = 'p1'").get()
  assert.equal(row.unit_cost, 2.6667)
  assert.equal(Number(row.valeur_inventaire), 40)
  assert.equal(applyFifo('p1').changed, false)
  assert.equal(applyFifo('fab').changed, false)
  assert.equal(db.prepare("SELECT unit_cost FROM products WHERE id = 'fab'").get().unit_cost, 3)
})

test('productIdsForPurchase résout le lien Airtable', () => {
  assert.deepEqual(productIdsForPurchase('a1'), ['p1'])
})
