import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cycleFromPeriodEnds, payPeriodOnOrAfter, payCalendar, parsePayKey, describePay } from './payrollCycle.js'

const cycle = cycleFromPeriodEnds(['2026-09-26', '2026-09-12', '2026-08-29', '2026-08-15'])

test('cycle : ancre = dernière fin, intervalle = écart dominant', () => {
  assert.deepEqual(cycle, { anchor_end: '2026-09-26', interval: 14 })
  assert.equal(cycleFromPeriodEnds([]), null)
})

test('prochaine paie : lundi préparer, mardi Nethris', () => {
  const p = payPeriodOnOrAfter(cycle, '2026-10-05')
  assert.equal(p.start, '2026-09-27')
  assert.equal(p.end, '2026-10-10')
  assert.deepEqual(p.steps.map(s => s.date), ['2026-10-09', '2026-10-13']) // lun 12 = Action de grâces
  assert.equal(p.steps[1].period_key, '2026-10-10-2')
})

test('semaine de paie : le mercredi garde encore la paie de la semaine', () => {
  assert.equal(payPeriodOnOrAfter(cycle, '2026-09-28').end, '2026-09-26')
  assert.equal(payPeriodOnOrAfter(cycle, '2026-09-30').end, '2026-10-10')
})

test('calendrier : une paie aux 14 jours', () => {
  const c = payCalendar(cycle, '2026-10-14', '2026-11-30')
  assert.deepEqual(c.map(p => p.steps[0].date), ['2026-10-26', '2026-11-09', '2026-11-23'])
})

test('férié : Action de grâce (lun 12 oct.) → préparer devancé au vendredi', () => {
  const p = payPeriodOnOrAfter(cycle, '2026-10-05')
  assert.deepEqual(p.steps.map(s => s.date), ['2026-10-09', '2026-10-13'])
  assert.equal(p.steps[0].holiday, 'Action de grâces')
  assert.equal(p.steps[0].period_key, '2026-10-10-1')
  assert.equal(p.steps[1].holiday, null)
})

test('sans férié : rien ne bouge', () => {
  // fin 2026-12-19 → lun 21, mar 22 : aucun férié
  const p = describePay(cycle, '2026-12-19')
  assert.deepEqual(p.steps.map(s => s.date), ['2026-12-21', '2026-12-22'])
  // fin 2027-01-02 → lun 4, mar 5 ; Jour de l'an 2027 = ven 1er : rien ne bouge
  assert.deepEqual(describePay(cycle, '2027-01-02').steps.map(s => s.date), ['2027-01-04', '2027-01-05'])
})

test('fériés lundi ET mardi (Noël 2027 observé lun 27, lendemain mar 28) : tout devancé', () => {
  const p = describePay({ anchor_end: '2027-12-25', interval: 14 }, '2027-12-25')
  assert.deepEqual(p.steps.map(s => s.date), ['2027-12-23', '2027-12-24'])
  assert.deepEqual(p.steps.map(s => s.holiday), ['Noël', 'Lendemain de Noël'])
})

test('clé de paie', () => {
  assert.equal(parsePayKey('2026-10-10-1').step.label, 'préparer')
  assert.equal(parsePayKey('2026-W33-1'), null)
})
