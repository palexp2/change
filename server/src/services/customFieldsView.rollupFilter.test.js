// Rollup à condition, suivi à rebours d'un champ lien Airtable : nombre
// d'achats d'une pièce dans les 365 derniers jours (purchases.nom_de_la_piece
// porte « ["recX"] », pas l'id ERP du produit).

import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'
import assert from 'node:assert/strict'

// DB jetable — n'ouvre jamais la vraie erp.db.
process.env.DATABASE_PATH = join(tmpdir(), `erp-test-rollupfilter-${process.pid}.db`)

const db = (await import('../db/database.js')).default
db.exec(`CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, airtable_id TEXT)`)
db.exec(`CREATE TABLE IF NOT EXISTS purchases (
  id TEXT PRIMARY KEY, nom_de_la_piece TEXT, date_de_commande TEXT, statut TEXT
)`)
db.exec(`CREATE TABLE IF NOT EXISTS custom_fields (
  id TEXT PRIMARY KEY, erp_table TEXT, column_name TEXT, name TEXT,
  kind TEXT, type TEXT, result_type TEXT, options TEXT, sort_order INTEGER,
  created_at TEXT, deleted_at TEXT, view_error TEXT,
  formula_expr TEXT, lookup_fk TEXT, lookup_target_table TEXT, lookup_target_column TEXT,
  lookup_limit_n INTEGER, lookup_limit_dir TEXT,
  rollup_target_table TEXT, rollup_target_fk TEXT, rollup_target_column TEXT, rollup_agg TEXT, rollup_filter TEXT,
  link_target_table TEXT, link_group_id TEXT, link_role TEXT, link_single INTEGER
)`)

const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString()
db.prepare('INSERT INTO products (id, airtable_id) VALUES (?,?)').run('p1', 'recP1')
db.prepare('INSERT INTO products (id, airtable_id) VALUES (?,?)').run('p2', 'recP2')
db.prepare('INSERT INTO products (id, airtable_id) VALUES (?,?)').run('p3', null)
const insP = db.prepare('INSERT INTO purchases (id, nom_de_la_piece, date_de_commande, statut) VALUES (?,?,?,?)')
insP.run('a1', '["recP1"]', daysAgo(10), 'Reçu')
insP.run('a2', 'recP1', daysAgo(200), 'Commandé')
insP.run('a3', '["recP1"]', daysAgo(500), 'Reçu')     // hors fenêtre
insP.run('a4', '["recP2"]', daysAgo(30), 'Reçu')
insP.run('a5', 'p3', daysAgo(5), 'Reçu')              // id ERP plutôt que record ID
insP.run('a6', '["p3"]', daysAgo(6), 'Reçu')

// « Pièce » : champ lien Airtable de purchases.
db.prepare(`INSERT INTO custom_fields (id, erp_table, column_name, name, kind, options)
            VALUES ('lnk','purchases','nom_de_la_piece','Pièce','data','{"airtable_link_hint":true}')`).run()
db.prepare(`
  INSERT INTO custom_fields (id, erp_table, column_name, name, kind, result_type,
                             rollup_target_table, rollup_target_fk, rollup_agg, rollup_filter, sort_order)
  VALUES ('cf1','products','cf_achats_1an','Achats 1 an','rollup','number','purchases','nom_de_la_piece','COUNT',?,0)
`).run(JSON.stringify({ column: 'date_de_commande', op: 'last_days', value: 365 }))

const { regenerateView, normalizeRollupFilter } = await import('./customFieldsView.js')

const valuesOf = () => Object.fromEntries(
  db.prepare('SELECT id, cf_achats_1an FROM products_v ORDER BY id').all().map(r => [r.id, r.cf_achats_1an])
)
const setFilter = f => db.prepare('UPDATE custom_fields SET rollup_filter=? WHERE id=?').run(f && JSON.stringify(f), 'cf1')

test('365 derniers jours : liens Airtable et id ERP appariés, achat ancien écarté', () => {
  regenerateView('products')
  assert.deepEqual(valuesOf(), { p1: 2, p2: 1, p3: 2 })
  // Index couvrant posé pour la condition.
  assert.ok(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='index' AND name LIKE 'idx_rollupf_purchases%'`).get())
})

test('sans condition : tous les achats liés', () => {
  setFilter(null)
  regenerateView('products')
  assert.deepEqual(valuesOf(), { p1: 3, p2: 1, p3: 2 })
})

test('condition texte (égal)', () => {
  setFilter({ column: 'statut', op: 'eq', value: 'Reçu' })
  regenerateView('products')
  assert.deepEqual(valuesOf(), { p1: 2, p2: 1, p3: 2 })
})

test('condition invalide refusée', () => {
  assert.equal(normalizeRollupFilter(null, 'purchases'), null)
  assert.throws(() => normalizeRollupFilter({ column: 'nope', op: 'eq', value: 'x' }, 'purchases'), /introuvable/)
  assert.throws(() => normalizeRollupFilter({ column: 'date_de_commande', op: 'DROP', value: 1 }, 'purchases'), /Opérateur/)
  assert.throws(() => normalizeRollupFilter({ column: 'date_de_commande', op: 'last_days', value: 'x' }, 'purchases'), /jours/)
})
