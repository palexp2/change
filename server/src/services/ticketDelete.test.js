// Régression : un billet ayant reçu un sondage de satisfaction était
// indélétable (ticket_surveys.ticket_id NOT NULL REFERENCES tickets(id) +
// foreign_keys = ON → « FOREIGN KEY constraint failed »).
//
// La DB de ce serveur EST la DB de prod : ces tests travaillent sur une base
// temporaire en mémoire qui reproduit les mêmes contraintes.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

process.env.NODE_ENV = 'test'

const { deleteTicketCascade } = await import('./ticketDelete.js')

function makeDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE tickets (id TEXT PRIMARY KEY, title TEXT);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, updated_at TEXT,
      ticket_id TEXT REFERENCES tickets(id));
    CREATE TABLE ticket_surveys (id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL REFERENCES tickets(id), deleted_at TEXT);
  `)
  db.prepare('INSERT INTO tickets (id, title) VALUES (?, ?)').run('t1', 'Billet')
  return db
}

test('un billet sans dépendance se supprime', () => {
  const db = makeDb()
  deleteTicketCascade(db, 't1')
  assert.equal(db.prepare('SELECT count(*) c FROM tickets').get().c, 0)
})

test('un billet avec un sondage se supprime, sondage compris', () => {
  const db = makeDb()
  db.prepare('INSERT INTO ticket_surveys (id, ticket_id) VALUES (?, ?)').run('s1', 't1')
  deleteTicketCascade(db, 't1')
  assert.equal(db.prepare('SELECT count(*) c FROM tickets').get().c, 0)
  assert.equal(db.prepare('SELECT count(*) c FROM ticket_surveys').get().c, 0)
})

test('un sondage déjà soft-deleted ne bloque pas non plus', () => {
  const db = makeDb()
  db.prepare('INSERT INTO ticket_surveys (id, ticket_id, deleted_at) VALUES (?, ?, ?)')
    .run('s1', 't1', '2026-01-01T00:00:00.000Z')
  deleteTicketCascade(db, 't1')
  assert.equal(db.prepare('SELECT count(*) c FROM tickets').get().c, 0)
})

test('les tâches survivent au billet, simplement déliées', () => {
  const db = makeDb()
  db.prepare('INSERT INTO tasks (id, title, ticket_id) VALUES (?, ?, ?)').run('k1', 'Tâche', 't1')
  deleteTicketCascade(db, 't1')
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get('k1')
  assert.ok(task, 'la tâche ne doit pas être supprimée')
  assert.equal(task.ticket_id, null)
  assert.ok(task.updated_at, 'updated_at doit être rafraîchi')
})

test('la suppression est atomique : rien ne bouge si elle échoue', () => {
  const db = makeDb()
  db.exec(`CREATE TABLE ticket_blockers (id TEXT PRIMARY KEY,
    ticket_id TEXT NOT NULL REFERENCES tickets(id))`)
  db.prepare('INSERT INTO ticket_surveys (id, ticket_id) VALUES (?, ?)').run('s1', 't1')
  db.prepare('INSERT INTO ticket_blockers (id, ticket_id) VALUES (?, ?)').run('b1', 't1')

  assert.throws(() => deleteTicketCascade(db, 't1'), /FOREIGN KEY/)
  assert.equal(db.prepare('SELECT count(*) c FROM tickets').get().c, 1)
  assert.equal(db.prepare('SELECT count(*) c FROM ticket_surveys').get().c, 1,
    'le sondage doit être restauré par le rollback')
})
