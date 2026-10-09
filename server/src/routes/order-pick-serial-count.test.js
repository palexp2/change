import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { buildTestApp, listen, closeServer, createTestUser, db, apiFetch } from '../test-helpers/testApp.js'
import ordersRouter from './orders.js'

const { base, server } = await listen(buildTestApp({ '/api/orders': ordersRouter }))
after(() => closeServer(server))
const { token } = createTestUser()
// Colonnes ajoutées en production par les imports et le soft-delete.
for (const [table, column] of [['products', 'deleted_at'], ['orders', 'deleted_at'], ['shipments', 'items_expedies']]) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`)
  }
}

function fixture({ serialized = true } = {}) {
  const order = randomUUID(), item = randomUUID(), product = randomUUID()
  db.prepare('INSERT INTO orders (id, order_number) VALUES (?, ?)').run(order,
    db.prepare('SELECT COALESCE(MAX(order_number), 0) + 1 AS n FROM orders').get().n)
  db.prepare('INSERT INTO products (id, name_fr, sku) VALUES (?, ?, ?)').run(product, 'Boîtier louvre', product)
  db.prepare("INSERT INTO order_items (id, order_id, product_id, qty, fulfillment_status) VALUES (?, ?, ?, 2, 'À prélever')").run(item, order, product)
  const serials = serialized ? [randomUUID(), randomUUID()] : []
  for (const serial of serials) db.prepare("INSERT INTO serial_numbers (id, serial, product_id, status) VALUES (?, ?, ?, 'Disponible - Vente')").run(serial, serial, product)
  return { order, item, product, serials }
}
const scan = (f, value) => apiFetch(base, token, 'POST', `/api/orders/${f.order}/scan`, { value, mode: 'pick' })
const patch = (f, body) => apiFetch(base, token, 'PATCH', `/api/orders/${f.order}/items/${f.item}`, body)
const read = f => db.prepare('SELECT * FROM order_items WHERE id=?').get(f.item)

test('dc6461 saisi à la main prélève DC6461 sans doublon au scan suivant', async () => {
  const f = fixture()
  db.prepare('UPDATE products SET name_fr=? WHERE id=?').run('Moteur de côté ouvrant droit', f.product)
  db.prepare('UPDATE serial_numbers SET serial=? WHERE id=?').run('DC6461', f.serials[0])
  db.prepare('UPDATE order_items SET qty=1 WHERE id=?').run(f.item)

  for (const value of [' dc6461 ', 'DC6461', 'Dc6461']) {
    const result = await scan(f, value)
    assert.equal(result.status, 200, JSON.stringify(result.body))
    assert.equal(result.body.type, 'serial')
    assert.equal(result.body.action, 'picked')
    assert.equal(result.body.serial.serial, 'DC6461')
    assert.equal(result.body.item.id, f.item)
    assert.equal(result.body.item.fulfilled_qty, 1)
    assert.equal(result.body.item.fulfillment_status, 'Prélevé')
    assert.deepEqual(result.body.item.serials.map(s => s.id), [f.serials[0]])
  }
  assert.equal(db.prepare('SELECT order_item_id FROM serial_numbers WHERE id=?').get(f.serials[0]).order_item_id, f.item)
})

test('la saisie en minuscules conserve le refus des séries indisponibles', async () => {
  const f = fixture()
  const code = `DC-${f.serials[0]}`.toUpperCase()
  db.prepare('UPDATE serial_numbers SET serial=?, status=? WHERE id=?').run(code, 'Opérationnel - Vendu', f.serials[0])
  const result = await scan(f, code.toLowerCase())
  assert.equal(result.status, 200)
  assert.equal(result.body.type, 'serial')
  assert.equal(result.body.action, 'not_available')
  assert.equal(read(f).fulfilled_qty, 0)
  assert.equal(db.prepare('SELECT order_item_id FROM serial_numbers WHERE id=?').get(f.serials[0]).order_item_id, null)
})

test('la vue commerciale reconnaît aussi une série saisie en minuscules', async () => {
  const f = fixture()
  const code = `DC-${f.serials[0]}`.toUpperCase()
  db.prepare('UPDATE serial_numbers SET serial=? WHERE id=?').run(code, f.serials[0])
  const result = await apiFetch(base, token, 'POST', `/api/orders/${f.order}/scan`, { value: code.toLowerCase(), mode: 'add' })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.equal(result.body.type, 'serial')
  assert.equal(result.body.action, 'linked')
  assert.equal(result.body.item.id, f.item)
  assert.equal(db.prepare('SELECT order_item_id FROM serial_numbers WHERE id=?').get(f.serials[0]).order_item_id, f.item)
})

test('deux boîtiers exigent deux séries distinctes, même après plusieurs scans du premier', async () => {
  const f = fixture()
  for (let n = 0; n < 3; n++) {
    const result = await scan(f, f.serials[0])
    assert.equal(result.status, 200, JSON.stringify(result.body))
    assert.equal(result.body.item.fulfilled_qty, 1)
    assert.equal(result.body.item.fulfillment_status, 'À prélever')
    assert.equal(result.body.item.serials.length, 1)
  }
  const result = await scan(f, f.serials[1])
  assert.equal(result.body.item.fulfilled_qty, 2)
  assert.equal(result.body.item.fulfillment_status, 'Prélevé')
  assert.equal(result.body.item.serials.length, 2)
})

test('une série ne quitte pas sa ligne complète pour remplir la suivante', async () => {
  const f = fixture()
  await scan(f, f.serials[0])
  await scan(f, f.serials[1])
  const next = randomUUID()
  db.prepare("INSERT INTO order_items (id, order_id, product_id, qty, fulfillment_status, sort_order) VALUES (?, ?, ?, 1, 'À prélever', 1)").run(next, f.order, f.product)
  await scan(f, f.serials[0])
  assert.equal(read(f).fulfilled_qty, 2)
  assert.equal(db.prepare('SELECT fulfilled_qty FROM order_items WHERE id=?').get(next).fulfilled_qty, 0)
  assert.equal(db.prepare('SELECT order_item_id FROM serial_numbers WHERE id=?').get(f.serials[0]).order_item_id, f.item)
})

test('le code produit et la validation manuelle ne remplacent pas la série manquante', async () => {
  const f = fixture()
  await scan(f, f.serials[0])
  const skuResult = await scan(f, f.product)
  assert.equal(skuResult.status, 400, JSON.stringify(skuResult.body))
  for (const body of [{ fulfillment_status: 'Prélevé' }, { fulfilled_qty: 2 }, { fulfillment_status: 'Prélevé', fulfilled_qty: 2 }]) {
    assert.equal((await patch(f, body)).status, 400)
  }
  assert.equal(read(f).fulfilled_qty, 1)
  assert.equal(read(f).fulfillment_status, 'À prélever')
})

test('un ancien compteur trop élevé est corrigé au scan et ne permet pas de créer un envoi', async () => {
  const f = fixture()
  await scan(f, f.serials[0])
  db.prepare("UPDATE order_items SET fulfilled_qty=2, fulfillment_status='Prélevé' WHERE id=?").run(f.item)
  const shipment = await apiFetch(base, token, 'POST', `/api/orders/${f.order}/shipments`, { item_ids: [f.item] })
  assert.equal(shipment.status, 400)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shipments WHERE order_id=?').get(f.order).n, 0)
  const result = await scan(f, f.serials[0])
  assert.equal(result.body.item.fulfilled_qty, 1)
  assert.equal(result.body.item.fulfillment_status, 'À prélever')
  await scan(f, f.serials[1])
  const completed = await apiFetch(base, token, 'POST', `/api/orders/${f.order}/shipments`, { item_ids: [f.item] })
  assert.equal(completed.status, 201, JSON.stringify(completed.body))
})

test('une série affectée à une autre commande reste protégée', async () => {
  const f = fixture(), other = fixture()
  await scan(f, f.serials[0])
  db.prepare('UPDATE order_items SET product_id=? WHERE id=?').run(f.product, other.item)
  assert.equal((await scan(other, f.serials[0])).status, 409)
  assert.equal(read(other).fulfilled_qty, 0)
})

test('les articles sans série se prélèvent toujours par code produit ou manuellement', async () => {
  const f = fixture({ serialized: false })
  const result = await scan(f, f.product)
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.equal(result.body.item.fulfilled_qty, 1)
  assert.equal((await scan(f, f.product)).body.item.fulfillment_status, 'Prélevé')
  assert.equal((await patch(f, { fulfillment_status: 'À prélever', fulfilled_qty: 0 })).status, 200)
  assert.equal((await patch(f, { fulfillment_status: 'Prélevé', fulfilled_qty: 2 })).status, 200)
})
