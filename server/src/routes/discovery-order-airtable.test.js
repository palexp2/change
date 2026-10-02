import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { buildTestApp, listen, closeServer, createTestUser, db } from '../test-helpers/testApp.js'
import formsRouter from './discovery-forms.js'
import ordersRouter from './orders.js'
import { mirrorDiscoveryOrder, settleDiscoveryOrderMirrors, retryPendingDiscoveryOrders, resetDiscoveryOrderRetryState } from '../services/discoveryOrderAirtable.js'

const app = buildTestApp({ '/api/discovery-forms': formsRouter, '/api/orders': ordersRouter })
const { base, server } = await listen(app)
after(() => closeServer(server))
const { token } = createTestUser()
const realFetch = globalThis.fetch

// Colonne dynamique de la table Pièces, lue par le calcul du coût expédié.
try { db.exec('ALTER TABLE products ADD COLUMN cout_unitaire TEXT') } catch {}
try { db.exec('ALTER TABLE orders ADD COLUMN deleted_at TIMESTAMP') } catch {}
const { up: createExports } = await import('../db/migrations/106-order-airtable-exports.js')
createExports(db)
db.prepare("INSERT INTO connector_oauth (id,connector,account_key,access_token) VALUES ('at','airtable','test','test-token')").run()
db.prepare('INSERT INTO airtable_orders_config (base_id,orders_table_id,items_table_id,field_map_items) VALUES (?,?,?,?)')
  .run('test-base', 'test-orders', 'test-items', JSON.stringify({ order: 'Commande', product: 'Produit', qty: 'Quantité', item_type: 'Type' }))
for (const [col, name, options] of [['company_id', 'Client final', { link_target_table: 'companies' }], ['notes', 'Notes', {}], ['order_number', '# de commande', { source: 'formula' }]]) {
  db.prepare('INSERT INTO airtable_field_mappings (id,module,erp_table,column_name,airtable_field_name,options) VALUES (?,?,?,?,?,?)')
    .run(col, 'orders', 'orders', col, name, JSON.stringify(options))
}
for (const [module, key] of [['orders', 'dyn:notes'], ['order_items', 'product'], ['order_items', 'qty'], ['order_items', 'item_type']]) {
  db.prepare('INSERT INTO airtable_field_directions (module,field_key,direction) VALUES (?,?,?)').run(module, key, 'both')
}
db.prepare('INSERT INTO companies (id,name,airtable_id) VALUES (?,?,?)').run('test-company', 'Test', 'recCompany00000001')
db.prepare('INSERT INTO products (id,name_fr,active,airtable_id) VALUES (?,?,1,?)').run('test-controller', 'Contrôleur central', 'recProduct00000001')

async function create(suffix) {
  db.prepare(`INSERT INTO customer_onboarding_responses
    (id,company_id,is_new_site,within_central_controller_range,greenhouses_json)
    VALUES (?,?,'add_to_existing',0,'[]')`).run(suffix, 'test-company')
  const response = await realFetch(`${base}/api/discovery-forms/${suffix}/create-order`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
  })
  const body = await response.json()
  await settleDiscoveryOrderMirrors()
  return { status: response.status, body }
}

function mockAirtable(t, failTable, extra = {}) {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.ok(String(url).startsWith('https://api.airtable.com/v0/test-base/'), String(url))
    assert.equal(options.method, 'POST')
    const table = String(url).split('/').at(-1)
    const fields = JSON.parse(options.body).fields
    calls.push({ table, fields })
    if (table === failTable) return new Response(JSON.stringify({ error: { message: 'Simulated failure' } }), { status: 422 })
    return new Response(JSON.stringify({ id: table === 'test-orders' ? `recOrder${String(calls.length).padStart(10, '0')}` : 'recItem0000000001', fields: { ...fields, ...(table === 'test-orders' ? extra : {}) } }))
  })
  return calls
}

test('System Builder crée le parent puis les articles avec leurs liens, sans exporter les anciennes commandes', async t => {
  db.prepare("INSERT INTO orders (id,order_number) VALUES ('old-test-order',100)").run()
  const calls = mockAirtable(t)
  const result = await create('successful-form')
  assert.equal(result.status, 201, JSON.stringify(result.body))
  assert.equal(result.body.airtable, undefined, 'la réponse n’attend pas Airtable')
  assert.deepEqual(calls.map(c => c.table), ['test-orders', 'test-items'])
  assert.deepEqual(calls[0].fields['Client final'], ['recCompany00000001'])
  const order = db.prepare('SELECT airtable_id FROM orders WHERE id=?').get(result.body.id)
  assert.deepEqual(calls[1].fields.Commande, [order.airtable_id])
  assert.deepEqual(calls[1].fields.Produit, ['recProduct00000001'])
  assert.equal(calls[1].fields.Quantité, 1)
  assert.equal(calls[1].fields.Type, 'Non facturable')
  assert.equal(db.prepare("SELECT airtable_id FROM orders WHERE id='old-test-order'").get().airtable_id, null)
  assert.equal((await mirrorDiscoveryOrder(result.body.id)).status, 'success')
  assert.equal(calls.length, 2, 'les fiches déjà liées ne sont pas recréées')
  const duplicate = await realFetch(`${base}/api/discovery-forms/successful-form/create-order`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
  assert.equal(duplicate.status, 409)
  assert.equal(calls.length, 2)
})

test('un échec du parent préserve la commande locale et ne crée aucun article Airtable', async t => {
  const calls = mockAirtable(t, 'test-orders')
  const result = await create('failed-form')
  assert.equal(result.status, 201)
  assert.equal(calls.length, 1)
  assert.equal(db.prepare('SELECT count(*) AS n FROM order_items WHERE order_id=?').get(result.body.id).n, 1)
  assert.ok(db.prepare("SELECT id FROM sync_log WHERE module='orders' AND status='error' AND error_message LIKE ?").get(`%${result.body.id}%`))
})

test('un échec article remonte un résultat partiel', async t => {
  const calls = mockAirtable(t, 'test-items')
  const result = await create('partial-form')
  assert.equal(result.status, 201)
  assert.equal(calls.length, 2)
  assert.equal(db.prepare('SELECT airtable_id FROM order_items WHERE order_id=?').get(result.body.id).airtable_id, null)
})

test('la reprise complète une commande partielle sans recréer le parent', async t => {
  const calls = mockAirtable(t)
  resetDiscoveryOrderRetryState()
  const results = await retryPendingDiscoveryOrders()
  assert.ok(results.length >= 1)
  assert.ok(results.every(r => r.status === 'success'), JSON.stringify(results))
  assert.ok(calls.length >= 1)
  const partial = db.prepare("SELECT generated_order_id AS id FROM customer_onboarding_responses WHERE id='partial-form'").get()
  assert.ok(db.prepare('SELECT airtable_id FROM order_items WHERE order_id=?').get(partial.id).airtable_id)
  assert.equal(calls.filter(c => c.table === 'test-orders').length, 1, 'seul le parent en échec est renvoyé')
  assert.deepEqual(await retryPendingDiscoveryOrders(), [], 'plus rien en attente')
})

test('la reprise espace les tentatives après un échec', async t => {
  resetDiscoveryOrderRetryState()
  db.prepare("INSERT INTO orders (id,order_number,company_id,notes) VALUES ('retry-order',200,'test-company','System Builder')").run()
  db.prepare("INSERT INTO customer_onboarding_responses (id,generated_order_id) VALUES ('retry-form','retry-order')").run()
  const calls = mockAirtable(t, 'test-orders')
  assert.equal((await retryPendingDiscoveryOrders())[0].status, 'error')
  assert.deepEqual(await retryPendingDiscoveryOrders(), [], 'pas de nouvelle tentative avant le délai')
  assert.equal(calls.length, 1)
})

test('un produit non lié ne crée pas une ligne orpheline dans Airtable', async t => {
  db.prepare("UPDATE products SET airtable_id=NULL WHERE id='test-controller'").run()
  t.after(() => db.prepare("UPDATE products SET airtable_id='recProduct00000001' WHERE id='test-controller'").run())
  const calls = mockAirtable(t)
  const result = await create('unlinked-product-form')
  assert.equal(result.status, 201)
  const again = await mirrorDiscoveryOrder(result.body.id)
  assert.equal(again.status, 'partial')
  assert.match(again.failures[0].error, /product_id/)
  assert.equal(calls.length, 1)
})

test('une commande créée à la main dans l’ERP part dans Airtable, puis ses articles ajoutés ensuite', async t => {
  const calls = mockAirtable(t)
  const post = (path, body) => realFetch(`${base}${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const created = await post('/api/orders', { company_id: 'test-company' })
  assert.equal(created.status, 201)
  const order = await created.json()
  await settleDiscoveryOrderMirrors()
  assert.deepEqual(calls.map(c => c.table), ['test-orders'])
  const linked = db.prepare('SELECT airtable_id, order_number FROM orders WHERE id=?').get(order.id)
  assert.ok(linked.airtable_id)
  assert.equal(calls[0].fields['# de commande'], `CMD-${order.order_number}`, 'Airtable hérite du numéro de Boréal')
  assert.equal((await post(`/api/orders/${order.id}/items`, { product_id: 'test-controller', qty: 2 })).status, 201)
  await settleDiscoveryOrderMirrors()
  assert.deepEqual(calls.map(c => c.table), ['test-orders', 'test-items'])
  assert.equal(calls[1].fields.Quantité, 2)
})
