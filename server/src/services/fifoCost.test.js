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
const { computeFifo, applyFifo, productIdsForPurchase, allFifoProductIds } = await import('./fifoCost.js')
const { computeBomCost, fabricatedAncestors, orderForRecompute } = await import('./bomCost.js')
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

db.exec(`
  CREATE TABLE products (id TEXT PRIMARY KEY, airtable_id TEXT, sku TEXT, name_fr TEXT, procurement_type TEXT, stock_qty REAL,
    unit_cost REAL, cout_unitaire TEXT, valeur_inventaire TEXT, deleted_at TEXT, updated_at TEXT);
  CREATE TABLE bom_items (id TEXT PRIMARY KEY, product_id TEXT, component_id TEXT, qty_required REAL DEFAULT 1);
  CREATE TABLE purchases (id TEXT PRIMARY KEY, airtable_id TEXT, at_id TEXT, nom_de_la_piece TEXT,
    quantite_commande TEXT, date_de_commande TEXT, created_at TEXT, cf_date_de_reception_complete TEXT,
    override_prix_unitaire_paye_cad TEXT, prix_unitaire_facture_cad TEXT, prix_unitaire_cad TEXT);
  CREATE TABLE product_opening_costs (product_id TEXT PRIMARY KEY, unit_cost REAL NOT NULL, set_by TEXT, set_at TEXT);
  CREATE TABLE purchase_price_approvals (purchase_id TEXT PRIMARY KEY, unit_price REAL NOT NULL, approved_by TEXT, approved_at TEXT);
  CREATE TABLE purchase_prices (airtable_id TEXT PRIMARY KEY, unit_price REAL, fetched_at TEXT);
  CREATE TABLE bom_free_components (product_id TEXT, component_id TEXT, set_by TEXT, set_at TEXT, PRIMARY KEY (product_id, component_id));
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

// ── Pièces fabriquées : coût de la nomenclature ─────────────────────────────
db.exec(`
  INSERT INTO products (id, airtable_id, procurement_type, stock_qty, unit_cost, cout_unitaire) VALUES
    ('vis', 'recV', 'Acheté', 100, 0.1, '0.1'), ('pcb', 'recB', 'Acheté', 10, 4, '4'),
    ('nu', 'recN', 'Acheté', 0, NULL, NULL), ('soft', 'recS', 'Logiciel', 0, NULL, NULL),
    ('sous', 'recSA', 'Fabriqué', 2, NULL, '1'), ('fini', 'recFI', 'Fabriqué', 3, 99, '99'),
    ('cy1', 'recC1', 'Fabriqué', 0, NULL, NULL), ('cy2', 'recC2', 'Fabriqué', 0, NULL, NULL);
  INSERT INTO bom_items VALUES
    ('l1', 'sous', 'pcb', 1), ('l2', 'sous', 'vis', 4),
    ('l3', 'fini', 'sous', 2), ('l4', 'fini', 'vis', 10), ('l5', 'fini', 'soft', 1),
    ('l6', 'cy1', 'cy2', 1), ('l7', 'cy2', 'cy1', 1), ('l8', 'cy2', 'pcb', 1);
`)

test('nomenclature simple : Σ quantité × coût du composant', () => {
  const r = computeBomCost('sous')
  assert.equal(r.cost, 4.4) // 1 × 4 + 4 × 0,10
  assert.deepEqual(r.issues, [])
})

test('sous-assemblage fabriqué valorisé récursivement, logiciel à 0 sans alerte', () => {
  const r = computeBomCost('fini')
  assert.equal(r.cost, 9.8) // 2 × 4,40 + 10 × 0,10 + 1 × 0
  assert.deepEqual(r.issues, [])
  assert.deepEqual(fabricatedAncestors(['pcb']).sort(), ['cy2', 'cy1', 'fini', 'sous'].sort())
  assert.deepEqual(orderForRecompute(['fini', 'sous', 'pcb']), ['pcb', 'sous', 'fini'])
})

test('cycle : alerte, pas de boucle', () => {
  const r = computeBomCost('cy1')
  assert.ok(r.issues.some(i => i.kind === 'cycle'))
  assert.ok(Number.isFinite(r.cost))
})

test('composant sans coût : alerte, exclu de la somme', () => {
  db.prepare("INSERT INTO bom_items VALUES ('l9', 'sous', 'nu', 3)").run()
  const r = computeBomCost('sous')
  assert.equal(r.cost, 4.4)
  assert.deepEqual(r.issues.map(i => [i.kind, i.component_id]), [['sans_cout', 'nu']])
  // Accepté sans coût pour ce produit : 0 $, plus d'alerte.
  db.prepare("INSERT INTO bom_free_components (product_id, component_id) VALUES ('sous', 'nu')").run()
  const ok = computeBomCost('sous')
  assert.equal(ok.cost, 4.4)
  assert.deepEqual(ok.issues, [])
  assert.equal(ok.lines.find(l => l.component_id === 'nu').free, true)
  db.prepare("DELETE FROM bom_free_components").run()
  db.prepare("DELETE FROM bom_items WHERE id = 'l9'").run()
})

test('applyFifo écrit le coût nomenclature dans unit_cost, cout_unitaire, valeur_inventaire', () => {
  const r = applyFifo('fini')
  assert.equal(r.changed, true)
  assert.equal(r.from, 99) // coût de la fiche
  assert.equal(r.to, 9.8)
  const row = db.prepare("SELECT unit_cost, cout_unitaire, valeur_inventaire FROM products WHERE id = 'fini'").get()
  assert.equal(row.unit_cost, 9.8)
  assert.equal(Number(row.cout_unitaire), 9.8)
  assert.equal(Number(row.valeur_inventaire), 29.4)
  const memo = JSON.parse(db.prepare("SELECT layers FROM product_fifo WHERE product_id = 'fini'").get().layers)
  assert.deepEqual(memo.map(l => [l.component_id, l.qty, l.unit_cost]), [['sous', 2, 4.4], ['vis', 10, 0.1], ['soft', 1, 0]])
  assert.equal(applyFifo('fini').changed, false)
})

test('pièce fabriquée sans nomenclature : coût en place gardé ; logiciels hors passe', () => {
  assert.equal(computeFifo('fab').eligible, false)
  assert.equal(applyFifo('fab').changed, false)
  const ids = allFifoProductIds()
  assert.ok(ids.includes('fini') && !ids.includes('soft'))
})
