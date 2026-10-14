import '../test-helpers/testEnv.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { apiFetch, buildTestApp, closeServer, createTestUser, db, initTestDb, listen } from '../test-helpers/testApp.js'
// retours.js prépare ses requêtes au chargement : schéma d'abord.
initTestDb()
const { default: retoursRouter } = await import('./retours.js')

const cols = t => new Set(db.pragma(`table_info(${t})`).map(c => c.name))
const addCols = (t, list) => { const have = cols(t); for (const c of list) if (!have.has(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} TEXT`) }

test('« Remplacement différé » : commande du client, adresses de la commande d’origine, # de série remplacé', async t => {
  initTestDb()
  addCols('return_items', ['commande'])
  addCols('order_items', ['de_serie', 'de_serie_remplace'])
  addCols('orders', ['deleted_at', 'adresse_de_livraison', 'adresse_de_la_ferme_pour_coordonnees_geographiques', 'farm_address_id'])
  addCols('products', ['cout_unitaire'])

  db.prepare("INSERT INTO companies (id, name) VALUES ('co1', 'Ferme')").run()
  db.prepare("INSERT INTO products (id, name_fr) VALUES ('pS', 'Contrôleur'), ('pX', 'Sonde')").run()
  db.prepare("INSERT INTO serial_numbers (id, airtable_id, serial, product_id, company_id, status) VALUES ('sn1', 'recSN1', 'CC1', 'pS', 'co1', 'En retour')").run()
  db.prepare("INSERT INTO adresses (id, line1, company_id, address_type) VALUES ('adL', '1 rang', 'co1', 'Livraison'), ('adF', '2 rang', 'co1', 'Ferme'), ('adL2', '3 rang', 'co1', 'Livraison')").run()
  db.prepare("INSERT INTO orders (id, order_number, company_id, status, address_id, farm_address_id, date_commande) VALUES ('o1', 10, 'co1', 'Envoyé', 'adL', 'adF', '2025-01-01'), ('o2', 11, 'co1', 'Envoyé', 'adL2', NULL, '2026-01-01')").run()
  db.prepare("INSERT INTO order_items (id, order_id, product_id, qty, de_serie) VALUES ('oi1', 'o1', 'pS', 1, '[\"recSN1\"]')").run()
  db.prepare("INSERT INTO returns (id) VALUES ('r1')").run()
  db.prepare("INSERT INTO return_items (id, return_id, serial_id, company_id) VALUES ('ri1', 'r1', 'sn1', 'co1'), ('ri2', 'r1', NULL, 'co1')").run()
  db.prepare("UPDATE return_items SET product_id = 'pX' WHERE id = 'ri2'").run()

  const { token } = createTestUser()
  const { server, base } = await listen(buildTestApp({ '/api/retours': retoursRouter }))
  t.after(() => closeServer(server))

  // Sans n° de série : produit de l'article, dernière commande du client.
  const r2 = await apiFetch(base, token, 'POST', '/api/retours/r1/deferred-replacement', { item_ids: ['ri2'] })
  assert.equal(r2.status, 201)
  const o2 = db.prepare('SELECT * FROM orders WHERE id = ?').get(r2.body.order.id)
  assert.equal(o2.address_id, 'adL2')
  assert.equal(o2.farm_address_id, 'adF')
  assert.equal(db.prepare('SELECT product_id FROM order_items WHERE order_id = ?').get(o2.id).product_id, 'pX')


  const r = await apiFetch(base, token, 'POST', '/api/retours/r1/deferred-replacement', { item_ids: ['ri1'] })
  assert.equal(r.status, 201)
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(r.body.order.id)
  assert.equal(order.company_id, 'co1')
  assert.equal(order.address_id, 'adL')
  assert.equal(order.farm_address_id, 'adF')
  const lines = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].product_id, 'pS')
  assert.equal(lines[0].item_type, 'Remplacement')
  assert.equal(lines[0].replaced_serial, 'sn1')
  assert.equal(lines[0].de_serie_remplace, 'recSN1')
  assert.equal(db.prepare("SELECT commande FROM return_items WHERE id = 'ri1'").get().commande, JSON.stringify([order.id]))

  const none = await apiFetch(base, token, 'POST', '/api/retours/r1/deferred-replacement', { item_ids: ['zzz'] })
  assert.equal(none.status, 400)
})
