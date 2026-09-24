import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { buildTestApp, listen, closeServer, createTestUser, db, apiFetch } from '../test-helpers/testApp.js'
import ordersRouter from './orders.js'

const { base, server } = await listen(buildTestApp({ '/api/orders': ordersRouter }))
after(() => closeServer(server))
const { token } = createTestUser()

function fixture({ qty = 5, picked = 5, serialized = false, status = 'Prélevé' } = {}) {
  const orderId = randomUUID(), itemId = randomUUID(), productId = randomUUID()
  db.prepare('INSERT INTO orders (id, order_number) VALUES (?, ?)').run(orderId, db.prepare('SELECT COALESCE(MAX(order_number), 0) + 1 AS n FROM orders').get().n)
  db.prepare('INSERT INTO products (id, name_fr, stock_qty) VALUES (?, ?, 20)').run(productId, 'Article de test')
  db.prepare('INSERT INTO order_items (id, order_id, product_id, qty, fulfilled_qty, fulfillment_status) VALUES (?, ?, ?, ?, ?, ?)')
    .run(itemId, orderId, productId, qty, picked, status)
  const serials = []
  if (serialized) for (let n = 0; n < picked; n++) {
    const id = randomUUID()
    db.prepare("INSERT INTO serial_numbers (id, serial, product_id, order_item_id, status) VALUES (?, ?, ?, ?, 'Disponible - Vente')")
      .run(id, `TEST-${id}`, productId, itemId)
    serials.push(id)
  }
  return { orderId, itemId, productId, serials }
}

const unpick = (f, body, auth = token) => apiFetch(base, auth, 'POST', `/api/orders/${f.orderId}/items/${f.itemId}/unpick`, body)
const item = f => db.prepare('SELECT * FROM order_items WHERE id = ?').get(f.itemId)

test('retirer plusieurs exemplaires puis le reste conserve la quantité commandée et le stock comptable', async () => {
  const f = fixture()
  let result = await unpick(f, { quantity: 2, expected_fulfilled_qty: 5 })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.equal(result.body.fulfilled_qty, 3)
  assert.equal(result.body.qty, 5)
  assert.equal(result.body.fulfillment_status, 'À prélever')
  assert.equal(result.body.product_name, 'Article de test')
  assert.deepEqual(result.body.serials, [])
  result = await unpick(f, { quantity: 3, expected_fulfilled_qty: 3 })
  assert.equal(result.status, 200)
  assert.equal(item(f).fulfilled_qty, 0)
  assert.equal(db.prepare('SELECT stock_qty FROM products WHERE id=?').get(f.productId).stock_qty, 20)
})

test('retirer une série précise conserve les autres, puis permet de la scanner à nouveau', async () => {
  const f = fixture({ qty: 3, picked: 3, serialized: true })
  const result = await unpick(f, { serial_id: f.serials[1], expected_fulfilled_qty: 3 })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.equal(result.body.fulfilled_qty, 2)
  assert.equal(result.body.fulfillment_status, 'À prélever')
  assert.deepEqual(result.body.serials.map(s => s.id).sort(), [f.serials[0], f.serials[2]].sort())
  assert.equal(db.prepare('SELECT order_item_id FROM serial_numbers WHERE id=?').get(f.serials[1]).order_item_id, null)
  const scan = await apiFetch(base, token, 'POST', `/api/orders/${f.orderId}/scan`, { value: `TEST-${f.serials[1]}`, mode: 'pick' })
  assert.equal(scan.status, 200, JSON.stringify(scan.body))
  assert.equal(scan.body.item.fulfilled_qty, 3)
  assert.equal(scan.body.item.fulfillment_status, 'Prélevé')
  assert.equal(scan.body.item.serials.length, 3)
})

test('la dernière série se retire même sur un prélèvement partiel', async () => {
  const f = fixture({ qty: 3, picked: 1, serialized: true, status: 'À prélever' })
  const result = await unpick(f, { serial_id: f.serials[0], expected_fulfilled_qty: 1 })
  assert.equal(result.status, 200)
  assert.equal(result.body.fulfilled_qty, 0)
  assert.deepEqual(result.body.serials, [])
})

test('une ligne en attente conserve son statut après retrait', async () => {
  const f = fixture({ status: 'En attente' })
  const result = await unpick(f, { quantity: 1, expected_fulfilled_qty: 5 })
  assert.equal(result.status, 200)
  assert.equal(result.body.fulfillment_status, 'En attente')
})

test('quantités invalides, excessives et requêtes ambiguës sont refusées sans mutation', async () => {
  const f = fixture()
  for (const quantity of [0, -1, 1.5, 6, '', null, '2x']) {
    assert.equal((await unpick(f, { quantity, expected_fulfilled_qty: 5 })).status, 400)
    assert.equal(item(f).fulfilled_qty, 5)
  }
  assert.equal((await unpick(f, { quantity: 1 })).status, 400)
  assert.equal((await unpick(f, { quantity: 1, serial_id: 'sn', expected_fulfilled_qty: 5 })).status, 400)
})

test('requête répétée ou périmée ne retire pas une seconde fois', async () => {
  const f = fixture()
  const body = { quantity: 2, expected_fulfilled_qty: 5 }
  assert.equal((await unpick(f, body)).status, 200)
  assert.equal((await unpick(f, body)).status, 409)
  assert.equal(item(f).fulfilled_qty, 3)
})

test('une série doit appartenir à la bonne ligne et se retire explicitement', async () => {
  const f = fixture({ serialized: true }), other = fixture({ serialized: true })
  assert.equal((await unpick(f, { serial_id: other.serials[0], expected_fulfilled_qty: 5 })).status, 409)
  assert.equal((await unpick({ ...f, orderId: other.orderId }, { serial_id: f.serials[0], expected_fulfilled_qty: 5 })).status, 404)
  assert.equal((await unpick(f, { quantity: 1, expected_fulfilled_qty: 5 })).status, 400)
  assert.equal(item(f).fulfilled_qty, 5)
  assert.equal(db.prepare('SELECT count(*) AS n FROM serial_numbers WHERE order_item_id=?').get(f.itemId).n, 5)
})

test('les articles dans un envoi ou expédiés sont protégés', async () => {
  for (const status of ["Dans l'envoi", 'Envoyé']) {
    const f = fixture({ status, serialized: true })
    assert.equal((await unpick(f, { serial_id: f.serials[0], expected_fulfilled_qty: 5 })).status, 409)
    assert.equal(item(f).fulfilled_qty, 5)
  }
  const f = fixture()
  const shipmentId = randomUUID()
  db.prepare('INSERT INTO shipments (id, order_id) VALUES (?,?)').run(shipmentId, f.orderId)
  db.prepare('UPDATE order_items SET shipment_id=? WHERE id=?').run(shipmentId, f.itemId)
  assert.equal((await unpick(f, { quantity: 1, expected_fulfilled_qty: 5 })).status, 409)
})

test('le scan continue de prélever une série liée avant la préparation', async () => {
  const f = fixture({ qty: 3, picked: 1, serialized: true, status: 'À prélever' })
  db.prepare('UPDATE order_items SET fulfilled_qty=0 WHERE id=?').run(f.itemId)
  const scan = await apiFetch(base, token, 'POST', `/api/orders/${f.orderId}/scan`, { value: `TEST-${f.serials[0]}`, mode: 'pick' })
  assert.equal(scan.status, 200)
  assert.equal(item(f).fulfilled_qty, 1)
  assert.equal(scan.body.item.serials[0].id, f.serials[0])
})

test('le retrait exige une session authentifiée', async () => {
  const f = fixture()
  assert.equal((await unpick(f, { quantity: 1, expected_fulfilled_qty: 5 }, null)).status, 401)
  assert.equal(item(f).fulfilled_qty, 5)
})
