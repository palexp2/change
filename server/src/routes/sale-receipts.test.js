// Tests d'intégration des routes /api/sale-receipts.
//
// Tourne sur une DB SQLite JETABLE (voir test-helpers/testApp.js) — pas la prod
// erp.db. Le « cleanup » CLAUDE.md (supprimer les records créés) est ici assuré
// par destroyTestDb() qui supprime le fichier DB entier en fin de process ; on
// peut donc insérer librement sans polluer quoi que ce soit.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  buildTestApp, listen, createTestUser, db,
  apiFetch, closeServer,
} from '../test-helpers/testApp.js'

let base, server, token

before(async () => {
  const app = buildTestApp()
  ;({ server, base } = await listen(app))
  // Vrai user en DB : sale_receipt_events.user_id a une FK vers users(id), donc
  // la journalisation d'événements (PATCH/archive) échouerait avec un id forgé.
  token = createTestUser({ role: 'admin' }).token
})

after(async () => {
  await closeServer(server)
})

// Insère un reçu directement en DB (la route POST /upload exige un multipart +
// déclenche une extraction OpenAI async — hors périmètre de ces tests routes).
function seedReceipt(fields = {}) {
  const id = randomUUID()
  db.prepare(`
    INSERT INTO sale_receipts (id, filename, original_name, file_type, status, company, total, items, created_by)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(
    id,
    fields.filename || `${id}.pdf`,
    fields.original_name || 'recu.pdf',
    fields.file_type || '.pdf',
    fields.status || 'done',
    fields.company || null,
    fields.total ?? null,
    fields.items || '[]',
    fields.created_by || null,
  )
  return id
}

test('GET / sans token → 401', async () => {
  const { status } = await apiFetch(base, null, 'GET', '/api/sale-receipts')
  assert.equal(status, 401)
})

test('GET / avec token → enveloppe { data, total, page, limit }', async () => {
  const { status, body } = await apiFetch(base, token, 'GET', '/api/sale-receipts')
  assert.equal(status, 200)
  assert.ok(Array.isArray(body.data))
  assert.equal(typeof body.total, 'number')
  assert.equal(body.page, 1)
})

test('GET /:id → reçu sérialisé avec items en tableau', async () => {
  const id = seedReceipt({ company: 'ACME', items: JSON.stringify([{ description: 'x', quantity: 1, unit_price: 2, total: 2 }]) })
  const { status, body } = await apiFetch(base, token, 'GET', `/api/sale-receipts/${id}`)
  assert.equal(status, 200)
  assert.equal(body.id, id)
  assert.equal(body.company, 'ACME')
  assert.ok(Array.isArray(body.items))
  assert.equal(body.items[0].description, 'x')
})

test('GET /:id inconnu → 404', async () => {
  const { status } = await apiFetch(base, token, 'GET', '/api/sale-receipts/does-not-exist')
  assert.equal(status, 404)
})

test('PATCH /:id devise invalide → 400', async () => {
  const id = seedReceipt()
  const { status, body } = await apiFetch(base, token, 'PATCH', `/api/sale-receipts/${id}`, { currency: 'DOLLARS' })
  assert.equal(status, 400)
  assert.match(body.error, /currency/)
})

test('PATCH /:id receipt_date mal formée → 400', async () => {
  const id = seedReceipt()
  const { status } = await apiFetch(base, token, 'PATCH', `/api/sale-receipts/${id}`, { receipt_date: '2026/01/01' })
  assert.equal(status, 400)
})

test('PATCH /:id total négatif → 400', async () => {
  const id = seedReceipt()
  const { status } = await apiFetch(base, token, 'PATCH', `/api/sale-receipts/${id}`, { total: -5 })
  assert.equal(status, 400)
})

test('PATCH /:id valide → persiste et normalise les items', async () => {
  const id = seedReceipt()
  const { status, body } = await apiFetch(base, token, 'PATCH', `/api/sale-receipts/${id}`, {
    company: 'Fournisseur Inc',
    total: 123.45,
    currency: 'cad',
    items: [{ description: 'Pièce', quantity: '2', unit_price: '10', total: '20' }],
  })
  assert.equal(status, 200)
  assert.equal(body.company, 'Fournisseur Inc')
  assert.equal(body.total, 123.45)
  assert.equal(body.currency, 'CAD')
  assert.equal(body.items[0].quantity, 2)
  assert.equal(body.items[0].unit_price, 10)
})

test('PATCH /:id sans champ modifiable → 400', async () => {
  const id = seedReceipt()
  const { status } = await apiFetch(base, token, 'PATCH', `/api/sale-receipts/${id}`, { not_a_field: 1 })
  assert.equal(status, 400)
})

test('archive puis unarchive bascule archived_at', async () => {
  const id = seedReceipt()
  const arch = await apiFetch(base, token, 'POST', `/api/sale-receipts/${id}/archive`)
  assert.equal(arch.status, 200)
  assert.ok(arch.body.archived_at)
  const un = await apiFetch(base, token, 'POST', `/api/sale-receipts/${id}/unarchive`)
  assert.equal(un.status, 200)
  assert.equal(un.body.archived_at, null)
})

test('GET /:id/history journalise les modifications', async () => {
  const id = seedReceipt()
  await apiFetch(base, token, 'PATCH', `/api/sale-receipts/${id}`, { memo: 'note test' })
  const { status, body } = await apiFetch(base, token, 'GET', `/api/sale-receipts/${id}/history`)
  assert.equal(status, 200)
  assert.ok(body.data.some(e => e.action === 'updated'))
})

test('DELETE /:id (sans gmail_message_id) hard-delete → 404 ensuite', async () => {
  const id = seedReceipt()
  const del = await apiFetch(base, token, 'DELETE', `/api/sale-receipts/${id}`)
  assert.equal(del.status, 200)
  assert.equal(del.body.ok, true)
  const after = await apiFetch(base, token, 'GET', `/api/sale-receipts/${id}`)
  assert.equal(after.status, 404)
})
