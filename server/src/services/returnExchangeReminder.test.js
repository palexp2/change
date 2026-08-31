// Tests pour la requête d'éligibilité du rappel « retours avec échange
// immédiat » (import Airtable #4) — la partie la plus sensible : une erreur
// de filtre enverrait des rappels aux mauvais clients.

import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

import { selectEligibleReturns, IMMEDIATE_REASON } from './returnExchangeReminder.js'

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE returns (
      id TEXT PRIMARY KEY,
      company_id TEXT,
      contact_id TEXT,
      billed_at TEXT,
      created_at TEXT
    );
    CREATE TABLE contacts (
      id TEXT PRIMARY KEY,
      email TEXT,
      first_name TEXT,
      langue TEXT
    );
    CREATE TABLE return_items (
      id TEXT PRIMARY KEY,
      return_id TEXT,
      return_reason TEXT,
      received_at TEXT
    );
  `)
  return db
}

function seedReturn(db, { id, contactId = 'c1', billedAt = null, createdAt = '2026-08-01T00:00:00.000Z', email = 'client@example.com' }) {
  db.prepare('INSERT INTO contacts (id, email, first_name, langue) VALUES (?, ?, ?, ?)').run(contactId, email, 'Marie', 'French')
  db.prepare('INSERT INTO returns (id, company_id, contact_id, billed_at, created_at) VALUES (?, ?, ?, ?, ?)').run(id, 'co1', contactId, billedAt, createdAt)
}

test('retour avec item immédiat non reçu, non facturé → éligible', () => {
  const db = makeDb()
  seedReturn(db, { id: 'r1' })
  db.prepare('INSERT INTO return_items (id, return_id, return_reason, received_at) VALUES (?, ?, ?, ?)').run('ri1', 'r1', IMMEDIATE_REASON, null)
  const rows = selectEligibleReturns(db, { nowIso: '2026-08-25T00:00:00.000Z' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].return_id, 'r1')
})

test('retour déjà facturé → exclu', () => {
  const db = makeDb()
  seedReturn(db, { id: 'r1', billedAt: '2026-08-10T00:00:00.000Z' })
  db.prepare('INSERT INTO return_items (id, return_id, return_reason, received_at) VALUES (?, ?, ?, ?)').run('ri1', 'r1', IMMEDIATE_REASON, null)
  const rows = selectEligibleReturns(db, { nowIso: '2026-08-25T00:00:00.000Z' })
  assert.equal(rows.length, 0)
})

test('item déjà reçu → exclu (plus rien à rappeler)', () => {
  const db = makeDb()
  seedReturn(db, { id: 'r1' })
  db.prepare('INSERT INTO return_items (id, return_id, return_reason, received_at) VALUES (?, ?, ?, ?)').run('ri1', 'r1', IMMEDIATE_REASON, '2026-08-20T00:00:00.000Z')
  const rows = selectEligibleReturns(db, { nowIso: '2026-08-25T00:00:00.000Z' })
  assert.equal(rows.length, 0)
})

test('raison différente d\'échange immédiat → exclu', () => {
  const db = makeDb()
  seedReturn(db, { id: 'r1' })
  db.prepare('INSERT INTO return_items (id, return_id, return_reason, received_at) VALUES (?, ?, ?, ?)').run('ri1', 'r1', 'Erreur de commande', null)
  const rows = selectEligibleReturns(db, { nowIso: '2026-08-25T00:00:00.000Z' })
  assert.equal(rows.length, 0)
})

test('avant la date plancher (2025-06-04) → exclu', () => {
  const db = makeDb()
  seedReturn(db, { id: 'r1', createdAt: '2025-01-01T00:00:00.000Z' })
  db.prepare('INSERT INTO return_items (id, return_id, return_reason, received_at) VALUES (?, ?, ?, ?)').run('ri1', 'r1', IMMEDIATE_REASON, null)
  const rows = selectEligibleReturns(db, { nowIso: '2026-08-25T00:00:00.000Z' })
  assert.equal(rows.length, 0)
})

test('sans courriel de contact → exclu', () => {
  const db = makeDb()
  seedReturn(db, { id: 'r1', email: null })
  db.prepare('INSERT INTO return_items (id, return_id, return_reason, received_at) VALUES (?, ?, ?, ?)').run('ri1', 'r1', IMMEDIATE_REASON, null)
  const rows = selectEligibleReturns(db, { nowIso: '2026-08-25T00:00:00.000Z' })
  assert.equal(rows.length, 0)
})
