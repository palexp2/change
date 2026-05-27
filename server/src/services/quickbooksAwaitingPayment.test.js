// Garde anti-AR-fantôme : factureHasQbPaymentEntry doit signaler qu'aucune
// trace QB d'encaissement n'existe encore pour la facture, auquel cas
// reconcileFactureRevenueRecognition skip avec 'awaiting_payment_qb_entry'
// au lieu de poster Dr AR / Cr 40000 (cas Ferme du Vert Mouton 2BE77A55-0003 /
// JE 17373, mai 2026 : facture marquée payée out-of-band dans Stripe, aucun
// charge donc pas de payout à venir, et payment ERP pas encore saisi → l'AR
// ouvert ne serait jamais soldé).

import { tmpdir } from 'os'
import { join } from 'path'
import { unlinkSync } from 'fs'
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

const tmpDbPath = join(tmpdir(), `erp-test-awaiting-payment-${process.pid}.db`)
process.env.DATABASE_PATH = tmpDbPath

const bootDb = new Database(tmpDbPath)
bootDb.exec(`
  CREATE TABLE factures (
    id TEXT PRIMARY KEY,
    invoice_id TEXT,
    paid_charge_id TEXT
  );
  CREATE TABLE payments (
    id TEXT PRIMARY KEY,
    facture_id TEXT,
    direction TEXT,
    qb_deposit_id TEXT,
    qb_payment_id TEXT,
    qb_journal_entry_id TEXT
  );
  CREATE TABLE stripe_payouts (
    id TEXT PRIMARY KEY,
    stripe_id TEXT UNIQUE,
    qb_deposit_id TEXT
  );
  CREATE TABLE stripe_balance_transactions (
    id TEXT PRIMARY KEY,
    stripe_id TEXT,
    payout_stripe_id TEXT,
    stripe_invoice_id TEXT
  );
`)
bootDb.close()

const { factureHasQbPaymentEntry } = await import('./quickbooks.js')
const dbModule = await import('../db/database.js')
const db = dbModule.default

test.after(() => {
  try { db.close() } catch {}
  try { unlinkSync(tmpDbPath) } catch {}
})

function reset() {
  db.exec('DELETE FROM stripe_balance_transactions; DELETE FROM stripe_payouts; DELETE FROM payments; DELETE FROM factures;')
}

test('facture inconnue → false', () => {
  reset()
  assert.equal(factureHasQbPaymentEntry('nope'), false)
})

test('facture payée out-of-band Stripe sans aucun payment ERP → false (cas du bug)', () => {
  // Reproduit exactement le scénario 2BE77A55-0003 : invoice Stripe marquée
  // payée à la main (paid_charge_id null car pas de charge), aucun payment
  // ERP, aucune balance_transaction. Sans cette garde, reconcile poste
  // Dr AR / Cr 40000.
  reset()
  db.prepare('INSERT INTO factures (id, invoice_id, paid_charge_id) VALUES (?, ?, ?)')
    .run('f1', 'in_paid_out_of_band', null)
  assert.equal(factureHasQbPaymentEntry('f1'), false)
})

test('payment ERP avec qb_deposit_id posé → true', () => {
  reset()
  db.prepare('INSERT INTO factures (id, invoice_id, paid_charge_id) VALUES (?, ?, ?)')
    .run('f2', 'in_x', null)
  db.prepare('INSERT INTO payments (id, facture_id, direction, qb_deposit_id) VALUES (?, ?, ?, ?)')
    .run('p1', 'f2', 'in', 'qb_dep_42')
  assert.equal(factureHasQbPaymentEntry('f2'), true)
})

test('payment ERP avec qb_journal_entry_id posé → true', () => {
  reset()
  db.prepare('INSERT INTO factures (id, invoice_id, paid_charge_id) VALUES (?, ?, ?)')
    .run('f3', null, null)
  db.prepare('INSERT INTO payments (id, facture_id, direction, qb_journal_entry_id) VALUES (?, ?, ?, ?)')
    .run('p2', 'f3', 'in', 'qb_je_99')
  assert.equal(factureHasQbPaymentEntry('f3'), true)
})

test('payment ERP avec qb_payment_id posé → true', () => {
  reset()
  db.prepare('INSERT INTO factures (id, invoice_id, paid_charge_id) VALUES (?, ?, ?)')
    .run('f4', null, null)
  db.prepare('INSERT INTO payments (id, facture_id, direction, qb_payment_id) VALUES (?, ?, ?, ?)')
    .run('p3', 'f4', 'in', 'qb_sr_7')
  assert.equal(factureHasQbPaymentEntry('f4'), true)
})

test('payment ERP sans aucun qb_*_id → false (saisi mais QB pas encore posté)', () => {
  reset()
  db.prepare('INSERT INTO factures (id, invoice_id, paid_charge_id) VALUES (?, ?, ?)')
    .run('f5', null, null)
  db.prepare('INSERT INTO payments (id, facture_id, direction) VALUES (?, ?, ?)')
    .run('p4', 'f5', 'in')
  assert.equal(factureHasQbPaymentEntry('f5'), false)
})

test('payment direction=out (refund) ignoré, pas considéré comme encaissement', () => {
  reset()
  db.prepare('INSERT INTO factures (id, invoice_id, paid_charge_id) VALUES (?, ?, ?)')
    .run('f6', null, null)
  db.prepare('INSERT INTO payments (id, facture_id, direction, qb_deposit_id) VALUES (?, ?, ?, ?)')
    .run('p5', 'f6', 'out', 'qb_dep_neg')
  assert.equal(factureHasQbPaymentEntry('f6'), false)
})

test('balance_transaction Stripe liée à l\'invoice → true', () => {
  // Couvre le cas paiement Stripe normal : la BT existe (que le payout soit
  // poussé ou non) et reconcile peut soit skip via factureHasPendingStripeDeposit,
  // soit procéder (libération du deferred si deferred_revenue_at posé).
  reset()
  db.prepare('INSERT INTO factures (id, invoice_id, paid_charge_id) VALUES (?, ?, ?)')
    .run('f7', 'in_stripe', 'ch_xyz')
  db.prepare('INSERT INTO stripe_payouts (id, stripe_id, qb_deposit_id) VALUES (?, ?, ?)')
    .run('po1', 'po_1', 'qb_dep_pushed')
  db.prepare('INSERT INTO stripe_balance_transactions (id, stripe_id, payout_stripe_id, stripe_invoice_id) VALUES (?, ?, ?, ?)')
    .run('bt1', 'txn_1', 'po_1', 'in_stripe')
  assert.equal(factureHasQbPaymentEntry('f7'), true)
})
