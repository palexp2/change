// Garde anti-doublon : factureHasPendingStripeDeposit doit signaler qu'une
// constatation de vente serait prématurée tant qu'on n'a pas de signal complet
// sur le futur dépôt — sinon on poste Dr AR / Cr 40000 puis le dépôt redouble
// la ligne sur 40000 (cas Aristoloche REUJS7NQ-0001 / JE 17265, mai 2026).

import { tmpdir } from 'os'
import { join } from 'path'
import { unlinkSync } from 'fs'
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

const tmpDbPath = join(tmpdir(), `erp-test-pending-deposit-${process.pid}.db`)
process.env.DATABASE_PATH = tmpDbPath

// Schéma minimal — uniquement les colonnes que la fonction sous test interroge.
// Synchroniser à la main avec schema.js si la fonction évolue.
const bootDb = new Database(tmpDbPath)
bootDb.exec(`
  CREATE TABLE factures (
    id TEXT PRIMARY KEY,
    invoice_id TEXT,
    paid_charge_id TEXT
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

// Import APRÈS DATABASE_PATH posé : la singleton ouvre le fichier tmp.
const { factureHasPendingStripeDeposit } = await import('./quickbooks.js')
const dbModule = await import('../db/database.js')
const db = dbModule.default

test.after(() => {
  try { db.close() } catch {}
  try { unlinkSync(tmpDbPath) } catch {}
})

function reset() {
  db.exec('DELETE FROM stripe_balance_transactions; DELETE FROM stripe_payouts; DELETE FROM factures;')
}

test('facture sans invoice_id → false (paiement non-Stripe)', () => {
  reset()
  db.prepare('INSERT INTO factures (id, invoice_id, paid_charge_id) VALUES (?, ?, ?)')
    .run('f1', null, null)
  assert.equal(factureHasPendingStripeDeposit('f1'), false)
})

test('facture Stripe non payée (paid_charge_id null) → false', () => {
  reset()
  db.prepare('INSERT INTO factures (id, invoice_id, paid_charge_id) VALUES (?, ?, ?)')
    .run('f2', 'in_abc', null)
  assert.equal(factureHasPendingStripeDeposit('f2'), false)
})

test('Stripe a chargé mais aucune balance_transaction synchronisée → true', () => {
  // Cas Aristoloche : invoice.paid arrivé (paid_charge_id posé), mais Stripe
  // n'a pas encore émis la balance_transaction (T+0 → T+2). Sans cette garde,
  // un constat de vente déclenché ici poserait Dr AR / Cr 40000, puis le
  // futur dépôt rebookerait la ligne sur 40000 (double comptage).
  reset()
  db.prepare('INSERT INTO factures (id, invoice_id, paid_charge_id) VALUES (?, ?, ?)')
    .run('f3', 'in_pending', 'py_xyz')
  assert.equal(factureHasPendingStripeDeposit('f3'), true)
})

test('balance_transaction synchronisée mais payout pas encore poussé en QB → true', () => {
  reset()
  db.prepare('INSERT INTO factures (id, invoice_id, paid_charge_id) VALUES (?, ?, ?)')
    .run('f4', 'in_synced', 'py_xyz')
  db.prepare('INSERT INTO stripe_payouts (id, stripe_id, qb_deposit_id) VALUES (?, ?, ?)')
    .run('po1', 'po_1', null)
  db.prepare('INSERT INTO stripe_balance_transactions (id, stripe_id, payout_stripe_id, stripe_invoice_id) VALUES (?, ?, ?, ?)')
    .run('bt1', 'txn_1', 'po_1', 'in_synced')
  assert.equal(factureHasPendingStripeDeposit('f4'), true)
})

test('balance_transaction synchronisée et payout déjà poussé en QB → false', () => {
  // Le dépôt a déjà été créé en QB : la garde ne s'applique plus, le constat
  // de vente peut procéder normalement (cas où shipment se fait après push).
  reset()
  db.prepare('INSERT INTO factures (id, invoice_id, paid_charge_id) VALUES (?, ?, ?)')
    .run('f5', 'in_pushed', 'py_xyz')
  db.prepare('INSERT INTO stripe_payouts (id, stripe_id, qb_deposit_id) VALUES (?, ?, ?)')
    .run('po2', 'po_2', 'qb_deposit_42')
  db.prepare('INSERT INTO stripe_balance_transactions (id, stripe_id, payout_stripe_id, stripe_invoice_id) VALUES (?, ?, ?, ?)')
    .run('bt2', 'txn_2', 'po_2', 'in_pushed')
  assert.equal(factureHasPendingStripeDeposit('f5'), false)
})

test('facture inconnue → false', () => {
  reset()
  assert.equal(factureHasPendingStripeDeposit('does-not-exist'), false)
})
