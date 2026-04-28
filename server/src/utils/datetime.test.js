import { test } from 'node:test'
import assert from 'node:assert/strict'
import { naiveLocalToUtcIso, normalizeToUtcIso } from './datetime.js'

test('naiveLocalToUtcIso — Toronto naif EDT', () => {
  // 23 avril 2026 est en EDT (UTC-4)
  assert.equal(
    naiveLocalToUtcIso('2026-04-23T12:10:10', 'America/Toronto'),
    '2026-04-23T16:10:10.000Z',
  )
})

test('naiveLocalToUtcIso — Toronto naif EST', () => {
  // 15 janvier 2026 est en EST (UTC-5)
  assert.equal(
    naiveLocalToUtcIso('2026-01-15T09:00:00', 'America/Toronto'),
    '2026-01-15T14:00:00.000Z',
  )
})

test('naiveLocalToUtcIso — idempotent sur ISO UTC', () => {
  assert.equal(
    naiveLocalToUtcIso('2026-04-23T16:10:10.000Z'),
    '2026-04-23T16:10:10.000Z',
  )
})

test('naiveLocalToUtcIso — retourne null si non parseable', () => {
  assert.equal(naiveLocalToUtcIso('pas une date'), null)
  assert.equal(naiveLocalToUtcIso(''), '')
  assert.equal(naiveLocalToUtcIso(null), null)
})

test('normalizeToUtcIso — format espace-séparé (SQLite now, déjà UTC)', () => {
  // Déjà UTC, juste reformater
  assert.equal(
    normalizeToUtcIso('2026-04-20 13:08:25'),
    '2026-04-20T13:08:25.000Z',
  )
})

test('normalizeToUtcIso — date seule reste intouchée', () => {
  assert.equal(normalizeToUtcIso('2025-04-30'), '2025-04-30')
})

test('normalizeToUtcIso — naïf ISO-T converti comme Toronto local', () => {
  assert.equal(
    normalizeToUtcIso('2026-04-23T12:10:10'),
    '2026-04-23T16:10:10.000Z',
  )
})

test('normalizeToUtcIso — ISO Z déjà canonique', () => {
  assert.equal(
    normalizeToUtcIso('2026-04-23T16:10:10.000Z'),
    '2026-04-23T16:10:10.000Z',
  )
})

test('normalizeToUtcIso — ms préservées pour espace-séparé avec fraction', () => {
  assert.equal(
    normalizeToUtcIso('2026-04-20 13:08:25.123'),
    '2026-04-20T13:08:25.123Z',
  )
})
