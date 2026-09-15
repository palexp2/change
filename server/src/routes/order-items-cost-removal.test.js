import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { buildTestApp, listen, closeServer, createTestUser, db, apiFetch } from '../test-helpers/testApp.js'
import ordersRouter from './orders.js'
import { computeShippedTotalCost, shippedCostSql } from '../services/shippedCost.js'

const { base, server } = await listen(buildTestApp({ '/api/orders': ordersRouter }))
after(() => closeServer(server))
const { token } = createTestUser()

test('articles sans coût actuel : ajout, modification, duplication et valorisation', async () => {
  assert(!db.pragma('table_info(order_items)').some(c => c.name === 'unit_cost'))
  // Colonne Airtable présente en production et utilisée par le coût de référence.
  if (!db.pragma('table_info(products)').some(c => c.name === 'cout_unitaire')) {
    db.exec('ALTER TABLE products ADD COLUMN cout_unitaire REAL')
  }
  if (!db.pragma('table_info(serial_numbers)').some(c => c.name === 'deleted_at')) {
    db.exec('ALTER TABLE serial_numbers ADD COLUMN deleted_at TEXT')
  }
  db.prepare('INSERT INTO products (id, name_fr, unit_cost, cout_unitaire) VALUES (?,?,?,?)')
    .run('cost-removal-product', 'Pièce test', 12, 15)
  db.prepare("INSERT INTO orders (id, order_number, status) VALUES (?, 900001, 'Commande vide')").run('cost-removal-order')

  const added = await apiFetch(base, token, 'POST', '/api/orders/cost-removal-order/items', {
    product_id: 'cost-removal-product', qty: 2, item_type: 'Facturable',
  })
  assert.equal(added.status, 201, JSON.stringify(added.body))
  assert(!Object.hasOwn(added.body, 'unit_cost'))
  assert.equal(computeShippedTotalCost(added.body.id).total, 30)

  const edited = await apiFetch(base, token, 'PATCH', `/api/orders/cost-removal-order/items/${added.body.id}`, { qty: 3 })
  assert.equal(edited.status, 200, JSON.stringify(edited.body))
  assert.equal(computeShippedTotalCost(added.body.id).total, 45)
  const duplicate = await apiFetch(base, token, 'POST', `/api/orders/cost-removal-order/items/${added.body.id}/duplicate`)
  assert.equal(duplicate.status, 201, JSON.stringify(duplicate.body))
  assert.equal(duplicate.body.qty, 3)
  assert(!Object.hasOwn(duplicate.body, 'unit_cost'))

  const retired = await apiFetch(base, token, 'PATCH', `/api/orders/cost-removal-order/items/${added.body.id}`, { unit_cost: 99 })
  assert.equal(retired.status, 400)
  // Une valeur historique gelée reste prioritaire même si le produit change.
  if (!db.pragma('table_info(order_items)').some(c => c.name === 'cout_total_au_moment_de_l_envoi')) {
    db.exec('ALTER TABLE order_items ADD COLUMN cout_total_au_moment_de_l_envoi TEXT')
  }
  db.prepare('UPDATE order_items SET cout_total_au_moment_de_l_envoi=? WHERE id=?').run('21', added.body.id)
  assert.equal(db.prepare(`SELECT ${shippedCostSql('oi')} AS cost FROM order_items oi WHERE id=?`).get(added.body.id).cost, 21)
})
