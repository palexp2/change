import test from 'node:test'
import assert from 'node:assert/strict'

import { parseDurationToMinutes, formatMinutes } from './duration.js'

test('parseDurationToMinutes — bare integer → minutes', () => {
  assert.strictEqual(parseDurationToMinutes('90'), 90)
  assert.strictEqual(parseDurationToMinutes('0'), 0)
  assert.strictEqual(parseDurationToMinutes(45), 45)
})

test('parseDurationToMinutes — HH:MM', () => {
  assert.strictEqual(parseDurationToMinutes('1:30'), 90)
  assert.strictEqual(parseDurationToMinutes('0:05'), 5)
  assert.strictEqual(parseDurationToMinutes('12:45'), 12 * 60 + 45)
})

test('parseDurationToMinutes — 1h30 / 1h', () => {
  assert.strictEqual(parseDurationToMinutes('1h30'), 90)
  assert.strictEqual(parseDurationToMinutes('2h'), 120)
})

test('parseDurationToMinutes — décimal heures', () => {
  assert.strictEqual(parseDurationToMinutes('1.5'), 90)
  assert.strictEqual(parseDurationToMinutes('0.25'), 15)
})

test('parseDurationToMinutes — null/empty → 0', () => {
  assert.strictEqual(parseDurationToMinutes(''), 0)
  assert.strictEqual(parseDurationToMinutes(null), 0)
  assert.strictEqual(parseDurationToMinutes(undefined), 0)
})

test('parseDurationToMinutes — rejette input invalide', () => {
  assert.strictEqual(parseDurationToMinutes('hello'), null)
  assert.strictEqual(parseDurationToMinutes('1:90'), null) // minutes > 59
})

test('formatMinutes — base cases', () => {
  assert.strictEqual(formatMinutes(0), '0:00')
  assert.strictEqual(formatMinutes(90), '1:30')
  assert.strictEqual(formatMinutes(5), '0:05')
  assert.strictEqual(formatMinutes(60), '1:00')
  assert.strictEqual(formatMinutes(125), '2:05')
})

test('formatMinutes — null/infini → 0:00', () => {
  assert.strictEqual(formatMinutes(null), '0:00')
  assert.strictEqual(formatMinutes(undefined), '0:00')
  assert.strictEqual(formatMinutes(Infinity), '0:00')
})

test('round-trip — 90 → parse → format == "1:30"', () => {
  assert.strictEqual(formatMinutes(parseDurationToMinutes('90')), '1:30')
  assert.strictEqual(formatMinutes(parseDurationToMinutes('1:30')), '1:30')
  assert.strictEqual(formatMinutes(parseDurationToMinutes('1.5')), '1:30')
})
