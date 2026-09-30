import { test } from 'node:test'
import assert from 'node:assert/strict'
import { quebecHolidays, holidaysInPeriod, nextPaiePeriod } from './paieSchedule.js'

test('fériés 2026 du Québec + 26 décembre', () => {
  assert.deepEqual(quebecHolidays(2026).map(h => h.date), [
    '2026-01-01', '2026-04-03', '2026-05-18', '2026-06-24', '2026-07-01',
    '2026-09-07', '2026-10-12', '2026-12-25', '2026-12-28',
  ])
})

test('férié de fin de semaine reporté au jour ouvrable suivant', () => {
  // 2027 : 25 déc. samedi, 26 dimanche, 1er jan. 2028 samedi.
  const d = quebecHolidays(2027).map(h => h.date)
  assert.ok(d.includes('2027-12-27') && d.includes('2027-12-28'))
  assert.ok(quebecHolidays(2028).some(h => h.date === '2028-01-03'))
})

test('rejoue le nombre de fériés des paies passées', () => {
  assert.equal(holidaysInPeriod('2026-06-21', '2026-07-04').length, 2)
  assert.equal(holidaysInPeriod('2026-05-10', '2026-05-23').length, 1)
  assert.equal(holidaysInPeriod('2026-03-29', '2026-04-11').length, 1)
  assert.equal(holidaysInPeriod('2025-12-21', '2026-01-03').length, 3)
  assert.equal(holidaysInPeriod('2025-10-12', '2025-10-25').length, 1)
  assert.equal(holidaysInPeriod('2026-04-12', '2026-04-25').length, 0)
})

test('période suivante : +14 jours, fin le samedi', () => {
  const p = nextPaiePeriod('2026-09-26')
  assert.equal(p.period_start, '2026-09-27')
  assert.equal(p.period_end, '2026-10-10')
  assert.equal(p.timesheets_deadline, '2026-10-13T11:00')
  assert.equal(p.nb_holiday_days, 0)
  assert.equal(nextPaiePeriod('2026-10-10').nb_holiday_days, 1)
  assert.equal(nextPaiePeriod(null, new Date(2026, 8, 30)).period_end, '2026-10-03')
})
