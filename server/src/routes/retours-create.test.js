import '../test-helpers/testEnv.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { apiFetch, buildTestApp, closeServer, createTestUser, db, initTestDb, listen } from '../test-helpers/testApp.js'
// retours.js prépare ses requêtes au chargement : schéma d'abord.
initTestDb()
const { default: retoursRouter } = await import('./retours.js')

const cols = t => new Set(db.pragma(`table_info(${t})`).map(c => c.name))
const addCols = (t, list) => { const have = cols(t); for (const c of list) if (!have.has(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} TEXT`) }

test('« Créer un retour » : articles, échange immédiat et # de série remplacé', async t => {
  initTestDb()
  addCols('return_items', ['billets', 'items_de_commande', 'commande'])
  addCols('order_items', ['de_serie_remplace', 'date_de_l_envoi'])
  addCols('orders', ['deleted_at', 'adresse_de_livraison'])
  addCols('serial_numbers', ['deleted_at'])
  addCols('products', ['besoin_d_un_numero_de_serie', 'cout_unitaire'])

  db.prepare("INSERT INTO companies (id, name) VALUES ('co1', 'Ferme'), ('co2', 'Autre')").run()
  db.prepare("INSERT INTO products (id, name_fr, besoin_d_un_numero_de_serie) VALUES ('pS', 'Contrôleur', '1.0'), ('pN', 'Câble', NULL), ('pR', 'Contrôleur v2', '1.0')").run()
  db.prepare("INSERT INTO serial_numbers (id, airtable_id, serial, product_id, company_id, status) VALUES ('sn1', 'recSN1', 'CC1', 'pS', 'co1', 'Opérationnel - Vendu'), ('sn2', NULL, 'CC2', 'pS', 'co1', 'Détruit'), ('sn3', NULL, 'CC3', 'pS', 'co2', 'Opérationnel - Vendu')").run()
  db.prepare("INSERT INTO orders (id, order_number, company_id, status) VALUES ('o1', 10, 'co1', 'Envoyé')").run()
  db.prepare("INSERT INTO order_items (id, order_id, product_id, qty, date_de_l_envoi) VALUES ('oi1', 'o1', 'pN', 5, '2025-01-01')").run()
  db.prepare("INSERT INTO tickets (id, airtable_id) VALUES ('tk1', 'recTK1')").run()
  db.prepare("INSERT INTO adresses (id, line1, company_id) VALUES ('ad1', '1 rang', 'co1')").run()
  db.prepare("INSERT INTO contacts (id, first_name, last_name, company_id) VALUES ('ct1', 'Marie', 'Roy', 'co1')").run()

  const { token } = createTestUser()
  const { server, base } = await listen(buildTestApp({ '/api/retours': retoursRouter }))
  t.after(() => closeServer(server))

  const cand = await apiFetch(base, token, 'GET', '/api/retours/company-candidates/co1')
  assert.equal(cand.status, 200)
  assert.deepEqual(cand.body.serials.map(s => s.id), ['sn1'])
  assert.deepEqual(cand.body.items.map(i => i.id), ['oi1'])

  const refused = await apiFetch(base, token, 'POST', '/api/retours/create', { company_id: 'co1', contact_id: 'ct1', items: [{ serial_id: 'sn3', reason: 'x' }] })
  assert.equal(refused.status, 400)

  const noContact = await apiFetch(base, token, 'POST', '/api/retours/create', { company_id: 'co1', items: [{ serial_id: 'sn1', reason: 'x' }] })
  assert.equal(noContact.status, 400)

  const r = await apiFetch(base, token, 'POST', '/api/retours/create', {
    company_id: 'co1', contact_id: 'ct1', ticket_id: 'tk1',
    items: [
      { serial_id: 'sn1', reason: 'Retour de garantie avec échange immédiat', notes: 'Écran', substitute_product_id: 'pR' },
      { order_item_id: 'oi1', qty: 2, reason: 'Erreur de commande' },
    ],
    exchange: { address_id: 'ad1' },
  })
  assert.equal(r.status, 201)
  assert.equal(r.body.count, 3)
  assert.ok(r.body.order?.created)

  const items = db.prepare('SELECT * FROM return_items WHERE return_id = ?').all(r.body.return_id)
  assert.equal(items.length, 3)
  assert.ok(items.every(i => i.company_id === 'co1' && i.billets === '["recTK1"]' && i.rma_processed_at))
  assert.equal(db.prepare("SELECT status FROM serial_numbers WHERE id='sn1'").get().status, 'En retour')

  const lines = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(r.body.order.id)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].product_id, 'pR')
  assert.equal(lines[0].item_type, 'Remplacement')
  assert.equal(lines[0].replaced_serial, 'sn1')
  assert.equal(lines[0].de_serie_remplace, 'recSN1')
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(r.body.order.id)
  assert.equal(order.company_id, 'co1')
  assert.equal(order.address_id, 'ad1')
  assert.equal(db.prepare('SELECT order_id FROM returns WHERE id = ?').get(r.body.return_id).order_id, order.id)
})
