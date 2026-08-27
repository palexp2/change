// Règle de datation d'un paiement fournisseur : dernier jour de l'échéance, et
// veille ouvrable si les banques sont fermées ce jour-là.
// Exécution : `node --test client/src/lib/bankDays.test.js`
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { payDateForDue, holidayName, isBankDay, bankDayOnOrBefore, easterSunday } from './bankDays.js'

const TODAY = '2026-08-12'   // mercredi ouvrable

test('échéance ouvrable : on paie le jour même, pas avant', () => {
  const r = payDateForDue('2027-01-20', TODAY)
  assert.equal(r.date, '2027-01-20')
  assert.equal(r.reason, 'due')
})

test('échéance en fin de semaine : jour ouvrable précédent', () => {
  assert.equal(payDateForDue('2027-01-16', TODAY).date, '2027-01-15') // samedi → vendredi
  assert.equal(payDateForDue('2027-01-17', TODAY).date, '2027-01-15') // dimanche → vendredi
  assert.equal(payDateForDue('2027-01-16', TODAY).reason, 'weekend')
})

test('échéance fériée : jour ouvrable précédent, avec le nom du férié', () => {
  const r = payDateForDue('2027-07-01', TODAY)
  assert.equal(r.date, '2027-06-30')
  assert.equal(r.reason, 'holiday')
  assert.equal(r.holiday, 'Fête du Canada')
})

test('férié collé à une fin de semaine : on remonte jusqu\'au jour ouvrable', () => {
  // Noël 2027 = samedi, lendemain de Noël = dimanche, repris lundi 27 et mardi 28.
  assert.equal(payDateForDue('2027-12-27', TODAY).date, '2027-12-24')
  assert.equal(payDateForDue('2027-12-28', TODAY).date, '2027-12-24')
  // Vendredi saint 2027 (26 mars) → jeudi 25.
  assert.equal(payDateForDue('2027-03-26', TODAY).date, '2027-03-25')
})

test('échéance dépassée : on paie dès aujourd\'hui', () => {
  const r = payDateForDue('2020-01-01', TODAY)
  assert.equal(r.date, TODAY)
  assert.equal(r.reason, 'late')
})

test('facture sans échéance : aujourd\'hui', () => {
  assert.equal(payDateForDue(null, TODAY).date, TODAY)
  assert.equal(payDateForDue(null, TODAY).reason, 'none')
})

test('fériés bancaires du Québec', () => {
  assert.equal(holidayName('2026-05-18'), 'Journée nationale des patriotes')
  assert.equal(holidayName('2026-06-24'), 'Fête nationale du Québec')
  assert.equal(holidayName('2026-09-07'), 'Fête du Travail')
  assert.equal(holidayName('2026-10-12'), 'Action de grâce')
  assert.equal(holidayName('2026-12-28'), 'Lendemain de Noël (reporté)') // 26 déc. = samedi
  assert.equal(holidayName('2026-08-14'), null)
  assert.equal(easterSunday(2026), '2026-04-05')
  assert.equal(isBankDay('2026-08-14'), true)
  assert.equal(isBankDay('2026-08-15'), false)
  assert.equal(bankDayOnOrBefore('2026-08-15'), '2026-08-14')
})
