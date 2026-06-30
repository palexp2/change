// Tests pour la persistance/reprise des push HubSpot échoués (ERP → HubSpot).
//
// Contexte : pushTaskFireAndForget avalait les erreurs dans un console.error et
// ne retentait jamais — un push échoué = divergence silencieuse ERP↔HubSpot,
// sans trace ni reprise. On vérifie ici le cœur du correctif : le backoff
// exponentiel borné et les opérations sur la file `hubspot_push_failures`
// (record/clear/status), sur une DB SQLite en mémoire — sans toucher la vraie
// DB ni l'API HubSpot.

import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

import {
  computePushRetryDelayMs,
  recordPushFailure,
  clearPushFailure,
  getPushFailureStatus,
} from './hubspotSync.js'

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT);
    CREATE TABLE hubspot_push_failures (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      first_failed_at TEXT,
      last_attempt_at TEXT,
      next_retry_at TEXT
    );
  `)
  db.prepare('INSERT INTO tasks (id, title) VALUES (?, ?)').run('t1', 'Tâche test')
  return db
}

// ── Backoff exponentiel ───────────────────────────────────────────────────────

test('backoff : 1er échec ≈ 1 min, double à chaque tentative, plafonné à 1 h', () => {
  assert.equal(computePushRetryDelayMs(1), 60 * 1000)
  assert.equal(computePushRetryDelayMs(2), 2 * 60 * 1000)
  assert.equal(computePushRetryDelayMs(3), 4 * 60 * 1000)
  assert.equal(computePushRetryDelayMs(7), 60 * 60 * 1000)   // 64 min → plafonné
  assert.equal(computePushRetryDelayMs(20), 60 * 60 * 1000)  // reste au plafond
})

test('backoff : attempts ≤ 0 est traité comme 1 (jamais de délai nul/négatif)', () => {
  assert.equal(computePushRetryDelayMs(0), 60 * 1000)
  assert.equal(computePushRetryDelayMs(-5), 60 * 1000)
})

// ── recordPushFailure ─────────────────────────────────────────────────────────

test('premier échec : insère la ligne avec attempts=1 et un next_retry futur', () => {
  const db = makeDb()
  const { attempts, nextRetry } = recordPushFailure('t1', 'HubSpot POST 500', db)
  assert.equal(attempts, 1)
  const row = db.prepare('SELECT * FROM hubspot_push_failures WHERE task_id=?').get('t1')
  assert.equal(row.attempts, 1)
  assert.equal(row.last_error, 'HubSpot POST 500')
  assert.ok(row.first_failed_at)
  assert.equal(row.last_attempt_at, row.first_failed_at)
  assert.equal(row.next_retry_at, nextRetry)
  assert.ok(new Date(nextRetry).getTime() > new Date(row.last_attempt_at).getTime())
})

test('échecs répétés : incrémente attempts et préserve first_failed_at', () => {
  const db = makeDb()
  recordPushFailure('t1', 'err 1', db)
  const first = db.prepare('SELECT * FROM hubspot_push_failures WHERE task_id=?').get('t1')
  const { attempts } = recordPushFailure('t1', 'err 2', db)
  const after = db.prepare('SELECT * FROM hubspot_push_failures WHERE task_id=?').get('t1')
  assert.equal(attempts, 2)
  assert.equal(after.attempts, 2)
  assert.equal(after.last_error, 'err 2')              // message rafraîchi
  assert.equal(after.first_failed_at, first.first_failed_at) // ancienneté préservée
})

test('message d\'erreur tronqué à 2000 caractères (pas de blob illimité en DB)', () => {
  const db = makeDb()
  recordPushFailure('t1', 'x'.repeat(5000), db)
  const row = db.prepare('SELECT last_error FROM hubspot_push_failures WHERE task_id=?').get('t1')
  assert.equal(row.last_error.length, 2000)
})

// ── clearPushFailure ──────────────────────────────────────────────────────────

test('clearPushFailure supprime la ligne (push redevenu OK = divergence résorbée)', () => {
  const db = makeDb()
  recordPushFailure('t1', 'boom', db)
  assert.equal(getPushFailureStatus(db).count, 1)
  clearPushFailure('t1', db)
  assert.equal(getPushFailureStatus(db).count, 0)
})

test('clearPushFailure sur une tâche sans échec est un no-op silencieux', () => {
  const db = makeDb()
  assert.doesNotThrow(() => clearPushFailure('inconnu', db))
  assert.equal(getPushFailureStatus(db).count, 0)
})

// ── getPushFailureStatus ──────────────────────────────────────────────────────

test('status : count, oldest et max_attempts agrègent la file', () => {
  const db = makeDb()
  db.prepare('INSERT INTO tasks (id, title) VALUES (?, ?)').run('t2', 'Autre')
  recordPushFailure('t1', 'a', db)
  recordPushFailure('t1', 'a', db) // t1 → 2 tentatives
  recordPushFailure('t2', 'b', db) // t2 → 1 tentative
  const s = getPushFailureStatus(db)
  assert.equal(s.count, 2)
  assert.equal(s.max_attempts, 2)
  assert.ok(s.oldest)
})

test('status sur file vide : count 0, oldest null', () => {
  const db = makeDb()
  const s = getPushFailureStatus(db)
  assert.equal(s.count, 0)
  assert.equal(s.oldest, null)
  assert.equal(s.max_attempts, 0)
})

// ── Intégrité référentielle ───────────────────────────────────────────────────

test('ON DELETE CASCADE : supprimer la tâche purge sa ligne de file', () => {
  const db = makeDb()
  db.pragma('foreign_keys = ON')
  recordPushFailure('t1', 'boom', db)
  db.prepare('DELETE FROM tasks WHERE id=?').run('t1')
  assert.equal(getPushFailureStatus(db).count, 0)
})
