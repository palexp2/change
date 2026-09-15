import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {
  buildTestApp, listen, createTestUser, db, apiFetch, closeServer,
} from '../test-helpers/testApp.js'
import productsRouter from './products.js'
import { reservePurchaseOrderNumber, resolvePurchaseOrderNumber } from '../services/purchaseOrderNumber.js'

describe('Numérotation des bons de commande', () => {
  let server, base, token

  before(async () => {
    const app = buildTestApp({ '/api/products': productsRouter })
    ;({ server, base } = await listen(app))
    token = createTestUser().token
    for (const id of ['po-product-a', 'po-product-b']) {
      db.prepare('INSERT INTO products (id, name_fr) VALUES (?, ?)').run(id, id)
    }
  })

  after(async () => { await closeServer(server) })

  test('commence à 1000 et incrémente de 1 pour chaque bon, tous produits confondus', async () => {
    const drafts = await Promise.all(['po-product-a', 'po-product-b', 'po-product-a'].map(id =>
      apiFetch(base, token, 'GET', `/api/products/${id}/purchase-order/prefill`)))
    for (const result of drafts) assert.equal(result.status, 200)
    assert.deepEqual(drafts.map(r => r.body.po_number).sort(), ['1000', '1001', '1002'])
  })

  test('les requêtes refusées ne consomment pas de numéro', async () => {
    assert.equal((await apiFetch(base, null, 'GET', '/api/products/po-product-a/purchase-order/prefill')).status, 401)
    assert.equal((await apiFetch(base, token, 'GET', '/api/products/inconnu/purchase-order/prefill')).status, 404)
    assert.equal(db.prepare('SELECT MAX(number) AS n FROM purchase_order_numbers').get().n, 1002)
  })

  test('le PDF et l’envoi réutilisent le numéro réservé sans avancer le compteur', () => {
    const number = reservePurchaseOrderNumber(db, 'po-product-a')
    assert.equal(number, '1003')
    for (let i = 0; i < 3; i++) {
      assert.equal(resolvePurchaseOrderNumber(db, 'po-product-a', number), number)
    }
    assert.equal(db.prepare('SELECT MAX(number) AS n FROM purchase_order_numbers').get().n, 1003)
  })

  test('les numéros arbitraires ou réservés pour un autre produit sont refusés avant PDF/envoi', async () => {
    for (const number of ['PO-ABC', '9999', '1003']) {
      const pdf = await apiFetch(base, token, 'POST', '/api/products/po-product-b/purchase-order/pdf', { po_number: number })
      assert.equal(pdf.status, 400)
      const email = await apiFetch(base, token, 'POST', '/api/products/po-product-b/purchase-order/send-email', {
        to: 'test@example.com', po: { po_number: number },
      })
      assert.equal(email.status, 400)
    }
  })

  test('un appel sans numéro utilise la même séquence, persistante entre connexions', () => {
    assert.equal(resolvePurchaseOrderNumber(db, 'po-product-a', ''), '1004')
    const connection = new Database(process.env.__TEST_DB_PATH)
    try {
      assert.equal(reservePurchaseOrderNumber(connection, 'po-product-b'), '1005')
      assert.equal(resolvePurchaseOrderNumber(connection, 'po-product-a', '1003'), '1003')
    } finally {
      connection.close()
    }
    assert.equal(reservePurchaseOrderNumber(db, 'po-product-a'), '1006')
  })
})
