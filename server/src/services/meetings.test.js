import test from 'node:test'
import assert from 'node:assert/strict'
import { zonedToUtc, localDate, computeSlots, slugify } from './meetings.js'

const TZ = 'America/Toronto'

const type = (over = {}) => ({
  timezone: TZ, slot_interval: 30, buffer_before: 0, buffer_after: 0, min_notice_hours: 0, max_days_ahead: 0,
  availability: { 1: [['09:00', '11:00']] }, ...over,
})

// Lundi 2026-10-05, 06:00 heure de Montréal (HAE, UTC-4).
const MONDAY_6AM = Date.parse('2026-10-05T10:00:00Z')

test('zonedToUtc tient compte de l’heure d’été et de l’heure normale', () => {
  assert.equal(new Date(zonedToUtc('2026-10-05', '09:00', TZ)).toISOString(), '2026-10-05T13:00:00.000Z')
  assert.equal(new Date(zonedToUtc('2026-12-07', '09:00', TZ)).toISOString(), '2026-12-07T14:00:00.000Z')
  assert.equal(localDate(Date.parse('2026-10-06T02:00:00Z'), TZ), '2026-10-05')
})

test('créneaux d’une plage, au pas réglé, sans dépasser la fin', () => {
  const slots = computeSlots(type(), 30, MONDAY_6AM).map(s => new Date(s).toISOString())
  assert.deepEqual(slots, [
    '2026-10-05T13:00:00.000Z', '2026-10-05T13:30:00.000Z', '2026-10-05T14:00:00.000Z', '2026-10-05T14:30:00.000Z',
  ])
  assert.equal(computeSlots(type(), 60, MONDAY_6AM).length, 3)
})

test('préavis minimal et occupations (avec tampon) retirent les créneaux', () => {
  assert.equal(computeSlots(type({ min_notice_hours: 4 }), 30, MONDAY_6AM).length, 2)
  const busy = [{ start: Date.parse('2026-10-05T14:00:00Z'), end: Date.parse('2026-10-05T14:30:00Z') }]
  assert.equal(computeSlots(type(), 30, MONDAY_6AM, busy).length, 3)
  assert.equal(computeSlots(type({ buffer_after: 15 }), 30, MONDAY_6AM, busy).length, 2)
})

test('jours sans plage et horizon', () => {
  assert.equal(computeSlots(type({ availability: { 2: [['09:00', '10:00']] } }), 30, MONDAY_6AM).length, 0)
  assert.equal(computeSlots(type({ availability: { 2: [['09:00', '10:00']] }, max_days_ahead: 1 }), 30, MONDAY_6AM).length, 2)
})

test('slugify', () => {
  assert.equal(slugify('Démo serre — 30 min'), 'demo-serre-30-min')
})
