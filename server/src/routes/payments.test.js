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

test('GET /direct-deposits sans token → 401', async () => {
  const { status } = await apiFetch(base, null, 'GET', '/api/payments/direct-deposits')
  assert.equal(status, 401)
})

test('GET /direct-deposits — candidates = factures payées hors bande sans encaissement', async () => {
  // Candidat : paid_at posé, pas de charge ni de payment_intent, total > 0.
  const candidateId = seedFacture({ total_amount: 500, status: 'Payé' })
  db.prepare("UPDATE factures SET paid_at='2026-07-01T12:00:00.000Z' WHERE id=?").run(candidateId)
  // Pas candidat : payée via Stripe (charge id présent).
  const stripePaidId = seedFacture({ total_amount: 200, status: 'Payé' })
  db.prepare("UPDATE factures SET paid_at='2026-07-01T12:00:00.000Z', paid_charge_id='ch_test' WHERE id=?").run(stripePaidId)
  // Pas candidat : facture à 0 $ (abonnement gratuit).
  const zeroId = seedFacture({ total_amount: 0, status: 'Payé' })
  db.prepare("UPDATE factures SET paid_at='2026-07-01T12:00:00.000Z' WHERE id=?").run(zeroId)
  // Pas candidat : encaissement déjà saisi (row payments direction='in').
  const settledId = seedFacture({ total_amount: 300, status: 'Payé' })
  db.prepare("UPDATE factures SET paid_at='2026-07-01T12:00:00.000Z' WHERE id=?").run(settledId)
  await apiFetch(base, adminToken, 'POST', '/api/payments', {
    facture_id: settledId, direction: 'in', method: 'virement_bancaire', amount: 300, currency: 'CAD',
    skip_qb: true, qb_skip_reason: 'saisi_manuellement_qb',
  })

  const { status, body } = await apiFetch(base, adminToken, 'GET', '/api/payments/direct-deposits')
  assert.equal(status, 200)
  const candidateIds = body.candidates.map(c => c.id)
  assert.ok(candidateIds.includes(candidateId), 'facture payée hors bande doit être candidate')
  assert.ok(!candidateIds.includes(stripePaidId), 'facture payée via Stripe ne doit pas être candidate')
  assert.ok(!candidateIds.includes(zeroId), 'facture à 0 $ ne doit pas être candidate')
  assert.ok(!candidateIds.includes(settledId), 'facture avec encaissement saisi ne doit pas être candidate')
})

test('GET /direct-deposits — deposits = payments in hors Stripe uniquement', async () => {
  const fid = seedFacture({ total_amount: 150 })
  const created = await apiFetch(base, adminToken, 'POST', '/api/payments', {
    facture_id: fid, direction: 'in', method: 'cheque', amount: 150, currency: 'CAD',
    skip_qb: true, qb_skip_reason: 'hors_bande',
  })
  const pid = created.body.payment.id
  // Row Stripe (insérée directement — le POST refuse method='stripe') : exclue.
  const stripeFid = seedFacture({ total_amount: 80 })
  const stripePid = randomUUID()
  db.prepare(`
    INSERT INTO payments (id, facture_id, direction, method, received_at, amount, currency)
    VALUES (?,?,?,?,?,?,?)
  `).run(stripePid, stripeFid, 'in', 'stripe', '2026-07-01T12:00:00.000Z', 80, 'CAD')

  const { status, body } = await apiFetch(base, adminToken, 'GET', '/api/payments/direct-deposits')
  assert.equal(status, 200)
  const ids = body.deposits.map(d => d.id)
  assert.ok(ids.includes(pid), 'paiement chèque doit être listé')
  assert.ok(!ids.includes(stripePid), 'paiement Stripe ne doit pas être listé')
  const row = body.deposits.find(d => d.id === pid)
  assert.equal(row.qb_skipped, true)
  assert.equal(row.method, 'cheque')
  assert.equal(row.facture_id, fid)
})

test('POST / clear_paid_status — efface l\'état payé hors bande, refuse une vraie charge Stripe', async () => {
  // Facture payée hors bande : clear_paid_status accepté, paid_at effacé,
  // le paiement couvre le total → statut recalculé à Payé.
  const fid = seedFacture({ total_amount: 400, balance_due: 400, status: 'Payé' })
  db.prepare("UPDATE factures SET paid_at='2026-07-03T12:00:00.000Z', paid_amount=400 WHERE id=?").run(fid)
  const ok = await apiFetch(base, adminToken, 'POST', '/api/payments', {
    facture_id: fid, direction: 'in', method: 'virement_bancaire', amount: 400, currency: 'CAD',
    skip_qb: true, qb_skip_reason: 'saisi_manuellement_qb', clear_paid_status: true,
  })
  assert.equal(ok.status, 201)
  const f = db.prepare('SELECT paid_at, paid_charge_id, status, balance_due FROM factures WHERE id=?').get(fid)
  assert.equal(f.paid_at, null)
  assert.equal(f.status, 'Payé')
  assert.equal(f.balance_due, 0)

  // Facture payée via une vraie charge Stripe : refusé (409), rien n'est créé.
  const fid2 = seedFacture({ total_amount: 500, status: 'Payé' })
  db.prepare("UPDATE factures SET paid_at='2026-07-03T12:00:00.000Z', paid_charge_id='ch_real' WHERE id=?").run(fid2)
  const ko = await apiFetch(base, adminToken, 'POST', '/api/payments', {
    facture_id: fid2, direction: 'in', method: 'virement_bancaire', amount: 500, currency: 'CAD',
    skip_qb: true, qb_skip_reason: 'saisi_manuellement_qb', clear_paid_status: true,
  })
  assert.equal(ko.status, 409)
  const count = db.prepare('SELECT COUNT(*) AS c FROM payments WHERE facture_id=?').get(fid2).c
  assert.equal(count, 0)
})

test('GET /direct-deposits/:id — candidat, puis redirect vers le payment une fois saisi', async () => {
  const fid = seedFacture({ total_amount: 900, status: 'Payé' })
  db.prepare("UPDATE factures SET paid_at='2026-07-02T12:00:00.000Z' WHERE id=?").run(fid)

  // Avant saisie : la facture est un candidat.
  const before = await apiFetch(base, adminToken, 'GET', `/api/payments/direct-deposits/${fid}`)
  assert.equal(before.status, 200)
  assert.equal(before.body.kind, 'candidate')
  assert.equal(before.body.candidate.id, fid)

  // Saisie d'un encaissement hors-Stripe (skip_qb pour ne pas appeler QB).
  const created = await apiFetch(base, adminToken, 'POST', '/api/payments', {
    facture_id: fid, direction: 'in', method: 'virement_bancaire', amount: 900, currency: 'CAD',
    skip_qb: true, qb_skip_reason: 'saisi_manuellement_qb',
  })
  const pid = created.body.payment.id

  // L'id facture redirige vers le payment ; l'id payment renvoie le détail.
  const redir = await apiFetch(base, adminToken, 'GET', `/api/payments/direct-deposits/${fid}`)
  assert.equal(redir.body.kind, 'redirect')
  assert.equal(redir.body.payment_id, pid)
  const detail = await apiFetch(base, adminToken, 'GET', `/api/payments/direct-deposits/${pid}`)
  assert.equal(detail.body.kind, 'deposit')
  assert.equal(detail.body.deposit.facture_id, fid)
  assert.equal(detail.body.deposit.qb_skipped, true)

  // Id inconnu → 404.
  const missing = await apiFetch(base, adminToken, 'GET', '/api/payments/direct-deposits/nope')
  assert.equal(missing.status, 404)
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
