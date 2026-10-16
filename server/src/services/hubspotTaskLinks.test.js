// Liens client des tâches HubSpot : recopie des associations sans écraser l'ERP.

import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

import { applyTaskLinks } from './hubspotSync.js'

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, hubspot_task_id TEXT, company_id TEXT, contact_id TEXT);
    CREATE TABLE contacts (id TEXT PRIMARY KEY, hubspot_record_id TEXT, company_id TEXT);
    CREATE TABLE companies (id TEXT PRIMARY KEY, hubspot_record_id TEXT);
    INSERT INTO contacts VALUES ('k1', '555.0', 'c9');
    INSERT INTO companies VALUES ('c1', '777');
  `)
  return db
}

test('pose contact et entreprise depuis HubSpot (id « .0 » compris)', () => {
  const db = makeDb()
  db.exec(`INSERT INTO tasks VALUES ('t1', '1', NULL, NULL)`)
  assert.equal(applyTaskLinks('1', { hsContactId: '555', hsCompanyId: '777' }, db), true)
  assert.deepEqual({ ...db.prepare('SELECT contact_id, company_id FROM tasks').get() }, { contact_id: 'k1', company_id: 'c1' })
})

test("sans entreprise HubSpot, prend celle du contact", () => {
  const db = makeDb()
  db.exec(`INSERT INTO tasks VALUES ('t1', '1', NULL, NULL)`)
  applyTaskLinks('1', { hsContactId: '555' }, db)
  assert.equal(db.prepare('SELECT company_id FROM tasks').get().company_id, 'c9')
})

test("n'écrase jamais un lien déjà posé dans l'ERP", () => {
  const db = makeDb()
  db.exec(`INSERT INTO tasks VALUES ('t1', '1', 'cX', NULL)`)
  applyTaskLinks('1', { hsContactId: '555', hsCompanyId: '777' }, db)
  assert.deepEqual({ ...db.prepare('SELECT contact_id, company_id FROM tasks').get() }, { contact_id: 'k1', company_id: 'cX' })
})

test('id HubSpot inconnu : rien ne change', () => {
  const db = makeDb()
  db.exec(`INSERT INTO tasks VALUES ('t1', '1', NULL, NULL)`)
  assert.equal(applyTaskLinks('1', { hsCompanyId: '000' }, db), false)
})

test('lié seulement à une transaction : prend son contact et son entreprise', () => {
  const db = makeDb()
  db.exec(`INSERT INTO tasks VALUES ('t1', '1', NULL, NULL)`)
  assert.equal(applyTaskLinks('1', { hsDealContactId: '555', hsDealCompanyId: '777' }, db), true)
  assert.deepEqual({ ...db.prepare('SELECT contact_id, company_id FROM tasks').get() }, { contact_id: 'k1', company_id: 'c1' })
})

test("contact de la transaction d'une autre entreprise : ignoré", () => {
  const db = makeDb()
  db.exec(`INSERT INTO tasks VALUES ('t1', '1', NULL, NULL)`)
  applyTaskLinks('1', { hsCompanyId: '777', hsDealContactId: '555' }, db)
  assert.deepEqual({ ...db.prepare('SELECT contact_id, company_id FROM tasks').get() }, { contact_id: null, company_id: 'c1' })
})
