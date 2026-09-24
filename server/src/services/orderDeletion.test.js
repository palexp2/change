import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTestApp, db } from '../test-helpers/testApp.js'
import { deleteOrder } from './orderDeletion.js'

buildTestApp({})

try { db.exec('ALTER TABLE orders ADD COLUMN deleted_at TIMESTAMP') } catch {}
try { db.exec('ALTER TABLE shipments ADD COLUMN deleted_at TIMESTAMP') } catch {}
db.prepare("INSERT INTO connector_oauth (id,connector,account_key,access_token) VALUES ('at-del','airtable','test','test-token')").run()
db.prepare('INSERT INTO airtable_orders_config (base_id,orders_table_id,items_table_id) VALUES (?,?,?)').run('base', 'tblOrders', 'tblItems')

function seed(id, { airtable = true } = {}) {
  db.prepare('INSERT INTO orders (id,order_number,airtable_id) VALUES (?,?,?)').run(id, Math.floor(Math.random() * 1e6), airtable ? `recO${id}`.padEnd(17, '0') : null)
  db.prepare('INSERT INTO order_items (id,order_id,qty,airtable_id) VALUES (?,?,1,?)').run(`${id}-i`, id, airtable ? `recI${id}`.padEnd(17, '0') : null)
}

function mockAirtable(t, status = 200) {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: String(url), method: options.method })
    return new Response(status === 200 ? '{}' : '{"error":"x"}', { status })
  })
  return calls
}

test('une commande envoyée est refusée, rien n’est supprimé', async t => {
  seed('shipped')
  db.prepare("INSERT INTO shipments (id,order_id) VALUES ('shp','shipped')").run()
  const calls = mockAirtable(t)
  const r = await deleteOrder('shipped')
  assert.equal(r.status, 409)
  assert.deepEqual(r.shipment_ids, ['shp'])
  assert.equal(calls.length, 0)
  assert.equal(db.prepare("SELECT deleted_at FROM orders WHERE id='shipped'").get().deleted_at, null)
})

test('supprime les articles puis la commande dans Airtable, puis dans Boréal', async t => {
  seed('ok')
  const calls = mockAirtable(t)
  assert.equal((await deleteOrder('ok')).status, 200)
  assert.deepEqual(calls.map(c => [c.method, c.url.split('?')[0].split('/').at(-1)]), [['DELETE', 'tblItems'], ['DELETE', 'tblOrders']])
  const o = db.prepare("SELECT deleted_at, airtable_id FROM orders WHERE id='ok'").get()
  assert.ok(o.deleted_at)
  assert.equal(o.airtable_id, null)
  assert.equal(db.prepare("SELECT airtable_id FROM order_items WHERE id='ok-i'").get().airtable_id, null)
  assert.equal((await deleteOrder('ok')).status, 404)
})

test('un refus d’Airtable remet la commande intacte', async t => {
  seed('fail')
  mockAirtable(t, 500)
  assert.equal((await deleteOrder('fail')).status, 502)
  const o = db.prepare("SELECT deleted_at, airtable_id FROM orders WHERE id='fail'").get()
  assert.equal(o.deleted_at, null)
  assert.ok(o.airtable_id)
  assert.ok(db.prepare("SELECT airtable_id FROM order_items WHERE id='fail-i'").get().airtable_id)
})

test('une commande absente d’Airtable se supprime sans appel', async t => {
  seed('local', { airtable: false })
  const calls = mockAirtable(t)
  assert.equal((await deleteOrder('local')).status, 200)
  assert.equal(calls.length, 0)
})
