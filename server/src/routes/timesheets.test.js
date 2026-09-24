import '../test-helpers/testEnv.js'
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { buildTestApp, listen, createTestUser, db, apiFetch, closeServer } from '../test-helpers/testApp.js'
import timesheetsRouter from './timesheets.js'
import { up as createWeeks } from '../db/migrations/044-timesheet-weeks.js'
import { up as shiftWeeks } from '../db/migrations/076-timesheet-weeks-sunday.js'

let base, server
before(async () => {
  const app = buildTestApp({ '/api/timesheets': timesheetsRouter })
  createWeeks(db)
  ;({ base, server } = await listen(app))
})
after(async () => { await closeServer(server) })

test('une semaine va du dimanche au samedi, même au changement d’année', async () => {
  const { token } = createTestUser()
  for (const [start, dates, next] of [
    ['2026-09-06', ['2026-09-06', '2026-09-07', '2026-09-12'], '2026-09-13'],
    ['2025-12-28', ['2025-12-28', '2026-01-01', '2026-01-03'], '2026-01-04'],
    ['2026-03-08', ['2026-03-08', '2026-03-09', '2026-03-14'], '2026-03-15'],
  ]) {
    const saved = await apiFetch(base, token, 'PUT', '/api/timesheets/week', { date: dates[1], minutes: 2100 })
    assert.equal(saved.status, 201)
    assert.equal(saved.body.week_start, start)
    for (const date of dates) {
      const found = await apiFetch(base, token, 'GET', `/api/timesheets/week?date=${date}`)
      assert.equal(found.status, 200)
      assert.equal(found.body.id, saved.body.id)
    }
    const following = await apiFetch(base, token, 'GET', `/api/timesheets/week?date=${next}`)
    assert.equal(following.body, null)
  }
})

test('les contrôles de double saisie incluent dimanche et samedi, sans déborder', async () => {
  for (const date of ['2026-09-06', '2026-09-12']) {
    const { token } = createTestUser()
    const day = await apiFetch(base, token, 'POST', '/api/timesheets/day', { date, mode: 'simple' })
    assert.equal(day.status, 201)
    assert.equal((await apiFetch(base, token, 'PATCH', `/api/timesheets/day/${day.body.id}`, { start_time: '09:00', end_time: '10:00' })).status, 200)
    assert.equal((await apiFetch(base, token, 'PUT', '/api/timesheets/week', { date: '2026-09-09', minutes: 2100 })).status, 409)
    assert.equal((await apiFetch(base, token, 'PUT', '/api/timesheets/week', { date: '2026-09-13', minutes: 2100 })).status, 201)
  }
  const { token } = createTestUser()
  assert.equal((await apiFetch(base, token, 'PUT', '/api/timesheets/week', { date: '2026-09-06', minutes: 2100 })).status, 201)
  for (const [date, expected] of [['2026-09-05', 200], ['2026-09-06', 409], ['2026-09-12', 409], ['2026-09-13', 200]]) {
    const day = await apiFetch(base, token, 'POST', '/api/timesheets/day', { date, mode: 'simple' })
    assert.equal(day.status, 201)
    assert.equal((await apiFetch(base, token, 'PATCH', `/api/timesheets/day/${day.body.id}`, { start_time: '09:00', end_time: '10:00' })).status, expected, date)
  }
})

test('migration : totaux, identifiants et suppressions conservés, sans second décalage', () => {
  const memory = new Database(':memory:')
  try {
    memory.exec(`CREATE TABLE timesheet_weeks (id TEXT PRIMARY KEY, user_id TEXT, week_start TEXT, minutes INTEGER, deleted_at TEXT);
      CREATE UNIQUE INDEX user_week ON timesheet_weeks(user_id, week_start) WHERE deleted_at IS NULL;
      INSERT INTO timesheet_weeks VALUES
        ('a', 'u', '2026-09-07', 2100, NULL),
        ('b', 'u', '2026-09-14', 1800, NULL),
        ('c', 'u', '2026-09-07', 900, '2026-09-08'),
        ('d', 'v', '2025-12-29', 2400, NULL),
        ('e', 'v', '2026-09-06', 1200, NULL);`)
    assert.equal(shiftWeeks(memory).shifted, 4)
    assert.deepEqual(memory.prepare('SELECT id, week_start, minutes, deleted_at FROM timesheet_weeks ORDER BY id').all(), [
      { id: 'a', week_start: '2026-09-06', minutes: 2100, deleted_at: null },
      { id: 'b', week_start: '2026-09-13', minutes: 1800, deleted_at: null },
      { id: 'c', week_start: '2026-09-06', minutes: 900, deleted_at: '2026-09-08' },
      { id: 'd', week_start: '2025-12-28', minutes: 2400, deleted_at: null },
      { id: 'e', week_start: '2026-09-06', minutes: 1200, deleted_at: null },
    ])
    assert.equal(shiftWeeks(memory).shifted, 0)
  } finally { memory.close() }
})
