// Tests d'intégration des routes /api/payments (saisie manuelle paiement/refund).
//
// DB SQLite jetable (test-helpers/testApp.js) — pas la prod. On force skip_qb:true
// sur les POST valides pour ne pas appeler QuickBooks (le harnais n'a aucun
// connecteur tiers configuré).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  buildTestApp, listen, createTestUser, db,
  apiFetch, closeServer,
} from '../test-helpers/testApp.js'

let base, server, adminToken, salesToken

before(async () => {
  const app = buildTestApp()
  ;({ server, base } = await listen(app))
  // Vrais users en DB : payments.created_by a une FK vers users(id) (PRAGMA
  // foreign_keys=ON), un id forgé ferait échouer l'INSERT.
  adminToken = createTestUser({ role: 'admin' }).token
  salesToken = createTestUser({ role: 'sales' }).token
})

after(async () => {
  await closeServer(server)
})

function seedFacture(fields = {}) {
  const id = randomUUID()
  db.prepare(`
    INSERT INTO factures (id, status, currency, total_amount, balance_due, due_date)
    VALUES (?,?,?,?,?,?)
  `).run(
    id,
    fields.status || 'À payer',
    fields.currency || 'CAD',
    fields.total_amount ?? 100,
    fields.balance_due ?? (fields.total_amount ?? 100),
    fields.due_date || null,
  )
  return id
}

test('POST / sans token → 401', async () => {
  const { status } = await apiFetch(base, null, 'POST', '/api/payments', { facture_id: 'x' })
  assert.equal(status, 401)
})

test('POST / facture_id manquant → 400', async () => {
  const { status, body } = await apiFetch(base, adminToken, 'POST', '/api/payments', { direction: 'in' })
  assert.equal(status, 400)
  assert.match(body.error, /facture_id/)
})

test('POST / direction invalide → 400', async () => {
  const fid = seedFacture()
  const { status } = await apiFetch(base, adminToken, 'POST', '/api/payments', { facture_id: fid, direction: 'sideways', method: 'interac', amount: 10 })
  assert.equal(status, 400)
})

test('POST / method invalide → 400', async () => {
  const fid = seedFacture()
  const { status } = await apiFetch(base, adminToken, 'POST', '/api/payments', { facture_id: fid, direction: 'in', method: 'bitcoin', amount: 10 })
  assert.equal(status, 400)
})

test('POST / amount <= 0 → 400', async () => {
  const fid = seedFacture()
  const { status } = await apiFetch(base, adminToken, 'POST', '/api/payments', { facture_id: fid, direction: 'in', method: 'interac', amount: 0 })
  assert.equal(status, 400)
})

test('POST / currency invalide → 400', async () => {
  const fid = seedFacture()
  const { status } = await apiFetch(base, adminToken, 'POST', '/api/payments', { facture_id: fid, direction: 'in', method: 'interac', amount: 10, currency: 'EUR' })
  assert.equal(status, 400)
})

test('POST / facture inexistante → 404', async () => {
  const { status } = await apiFetch(base, adminToken, 'POST', '/api/payments', { facture_id: 'nope', direction: 'in', method: 'interac', amount: 10 })
  assert.equal(status, 404)
})

test('POST / valide (skip_qb) → 201, ligne créée, qb_skipped', async () => {
  const fid = seedFacture()
  const { status, body } = await apiFetch(base, adminToken, 'POST', '/api/payments', {
    facture_id: fid, direction: 'in', method: 'interac', amount: 42.5, currency: 'CAD',
    skip_qb: true, qb_skip_reason: 'saisi_manuellement_qb',
  })
  assert.equal(status, 201)
  assert.ok(body.payment.id)
  assert.equal(body.payment.amount, 42.5)
  assert.equal(body.qb_skipped, true)
  assert.equal(body.qb_skip_reason, 'saisi_manuellement_qb')
  assert.equal(body.payment.qb_skip_reason, 'saisi_manuellement_qb')
  assert.equal(body.qb, null)
})

test('POST / skip_qb sans motif → 400', async () => {
  const fid = seedFacture()
  const { status, body } = await apiFetch(base, adminToken, 'POST', '/api/payments', {
    facture_id: fid, direction: 'in', method: 'interac', amount: 10, currency: 'CAD', skip_qb: true,
  })
  assert.equal(status, 400)
  assert.match(body.error, /qb_skip_reason/)
})

test('POST / skip_qb motif invalide → 400', async () => {
  const fid = seedFacture()
  const { status, body } = await apiFetch(base, adminToken, 'POST', '/api/payments', {
    facture_id: fid, direction: 'in', method: 'interac', amount: 10, currency: 'CAD',
    skip_qb: true, qb_skip_reason: 'parce_que',
  })
  assert.equal(status, 400)
  assert.match(body.error, /qb_skip_reason/)
})

test('POST / paiement total met la facture à Payé (balance 0)', async () => {
  const fid = seedFacture({ total_amount: 100, balance_due: 100, status: 'À payer' })
  const { status } = await apiFetch(base, adminToken, 'POST', '/api/payments', {
    facture_id: fid, direction: 'in', method: 'virement_bancaire', amount: 100, currency: 'CAD', skip_qb: true, qb_skip_reason: 'autre',
  })
  assert.equal(status, 201)
  const f = db.prepare('SELECT balance_due, status FROM factures WHERE id=?').get(fid)
  assert.equal(f.balance_due, 0)
  assert.equal(f.status, 'Payé')
})

test('GET /facture/:id liste les paiements de la facture', async () => {
  const fid = seedFacture()
  await apiFetch(base, adminToken, 'POST', '/api/payments', {
    facture_id: fid, direction: 'in', method: 'cheque', amount: 30, currency: 'CAD', skip_qb: true, qb_skip_reason: 'hors_bande',
  })
  const { status, body } = await apiFetch(base, adminToken, 'GET', `/api/payments/facture/${fid}`)
  assert.equal(status, 200)
  assert.ok(Array.isArray(body))
  assert.equal(body.length, 1)
  assert.equal(body[0].amount, 30)
  assert.equal(body[0].qb_skipped, true)
  assert.equal(body[0].qb_skip_reason, 'hors_bande')
})

test('DELETE /:id refusé aux non-admins → 403', async () => {
  const fid = seedFacture()
  const created = await apiFetch(base, adminToken, 'POST', '/api/payments', {
    facture_id: fid, direction: 'in', method: 'interac', amount: 10, currency: 'CAD', skip_qb: true, qb_skip_reason: 'autre',
  })
  const pid = created.body.payment.id
  const { status } = await apiFetch(base, salesToken, 'DELETE', `/api/payments/${pid}`)
  assert.equal(status, 403)
})

test('DELETE /:id en admin → 200 et ligne supprimée', async () => {
  const fid = seedFacture()
  const created = await apiFetch(base, adminToken, 'POST', '/api/payments', {
    facture_id: fid, direction: 'in', method: 'interac', amount: 10, currency: 'CAD', skip_qb: true, qb_skip_reason: 'autre',
  })
  const pid = created.body.payment.id
  const del = await apiFetch(base, adminToken, 'DELETE', `/api/payments/${pid}`)
  assert.equal(del.status, 200)
  assert.equal(del.body.ok, true)
  const row = db.prepare('SELECT id FROM payments WHERE id=?').get(pid)
  assert.equal(row, undefined)
})
