import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { buildTestApp, listen, closeServer, createTestUser, db, apiFetch } from '../test-helpers/testApp.js'
import ordersRouter from './orders.js'

const { base, server } = await listen(buildTestApp({ '/api/orders': ordersRouter }))
after(() => closeServer(server))
const { token } = createTestUser()
// Colonne importée, absente d'une base de test neuve.
if (!db.prepare('PRAGMA table_info(order_items)').all().some(c => c.name === 'de_serie')) {
  db.exec('ALTER TABLE order_items ADD COLUMN de_serie TEXT')
}
const keys = ['rec00000000000001', 'rec00000000000002']

function fixture() {
  const order = randomUUID(), item = randomUUID(), serial = randomUUID()
  db.prepare('INSERT INTO orders (id, order_number) VALUES (?, ?)').run(order,
    db.prepare('SELECT COALESCE(MAX(order_number), 0) + 1 AS n FROM orders').get().n)
  db.prepare('INSERT INTO order_items (id, order_id, qty, fulfilled_qty, de_serie) VALUES (?, ?, 2, 2, ?)')
    .run(item, order, JSON.stringify(keys))
  db.prepare('INSERT INTO serial_numbers (id, serial, order_item_id) VALUES (?, ?, ?)').run(serial, serial, item)
  return { order, item, serial }
}
const patch = (f, value) => apiFetch(base, token, 'PATCH', `/api/orders/${f.order}/items/${f.item}`, { de_serie: value })

test('dissocier une référence conserve les autres et le prélèvement ; le dernier lien peut être retiré', async () => {
  const f = fixture()
  const result = await patch(f, JSON.stringify([keys[1]]))
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.deepEqual(JSON.parse(result.body.de_serie), [keys[1]])
  assert.equal(result.body.fulfilled_qty, 2)
  assert.equal(result.body.serials[0].id, f.serial)
  assert.equal((await patch(f, '[]')).status, 200)
  assert.equal(db.prepare('SELECT de_serie FROM order_items WHERE id=?').get(f.item).de_serie, '[]')
})

test('une association, une valeur invalide et une autre commande sont refusées', async () => {
  const f = fixture(), other = fixture()
  for (const value of ['oops', '{}', 'null', JSON.stringify(['rec00000000000003'])]) {
    assert.equal((await patch(f, value)).status, 400)
  }
  assert.equal((await patch({ ...f, order: other.order }, '[]')).status, 404)
  assert.deepEqual(JSON.parse(db.prepare('SELECT de_serie FROM order_items WHERE id=?').get(f.item).de_serie), keys)
})
