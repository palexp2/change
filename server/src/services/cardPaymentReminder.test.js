import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseWorkDays, nextWorkDay, isReminderDay, nextReminderDay, buildReminderMessage,
} from './cardPaymentReminder.js'

// Date cible le 24 (échéance réelle des cartes 26-27, on garde une marge),
// jours travaillés mardi + samedi.
const OPTS = { dueDay: 24, workDays: parseWorkDays('2,6') }

test('parseWorkDays : liste valide, fallback mardi/samedi', () => {
  assert.deepEqual([...parseWorkDays('2,6')].sort(), [2, 6])
  assert.deepEqual([...parseWorkDays('1 3 5')].sort(), [1, 3, 5])
  assert.deepEqual([...parseWorkDays('')].sort(), [2, 6])
  assert.deepEqual([...parseWorkDays('9,x')].sort(), [2, 6])
})

test('nextWorkDay : mardi → samedi, samedi → mardi', () => {
  assert.equal(nextWorkDay('2026-08-25', OPTS.workDays), '2026-08-29') // mardi → samedi
  assert.equal(nextWorkDay('2026-08-29', OPTS.workDays), '2026-09-01') // samedi → mardi (mois suivant)
})

test('la cible tombe un lundi → rappel le samedi 22', () => {
  // Août 2026 : le 24 est un lundi ; le mardi 25 serait déjà en retard.
  assert.equal(isReminderDay('2026-08-22', OPTS), true)
  assert.equal(isReminderDay('2026-08-25', OPTS), false)
  assert.equal(isReminderDay('2026-08-18', OPTS), false)
})

test('la cible tombe un jeudi → rappel le mardi 22', () => {
  // Septembre 2026 : le 24 est un jeudi ; samedi 26 = trop tard.
  assert.equal(isReminderDay('2026-09-22', OPTS), true)
  assert.equal(isReminderDay('2026-09-19', OPTS), false)
  assert.equal(isReminderDay('2026-09-26', OPTS), false) // après la cible
})

test('la cible tombe un samedi → rappel le jour même', () => {
  // Octobre 2026 : le 24 est un samedi.
  assert.equal(isReminderDay('2026-10-24', OPTS), true)
  assert.equal(isReminderDay('2026-10-20', OPTS), false)
})

test('exactement un rappel par mois sur 12 mois', () => {
  const hits = []
  const d = new Date(Date.UTC(2026, 0, 1, 12))
  for (let i = 0; i < 365; i++) {
    const iso = d.toISOString().slice(0, 10)
    if (isReminderDay(iso, OPTS)) hits.push(iso)
    d.setUTCDate(d.getUTCDate() + 1)
  }
  assert.equal(hits.length, 12, `attendu 12 rappels, obtenu ${hits.join(', ')}`)
  assert.deepEqual(hits.map(h => h.slice(5, 7)), ['01','02','03','04','05','06','07','08','09','10','11','12'])
  // Toujours dans la fenêtre [18, 24] : jamais plus de 6 jours d'avance.
  for (const h of hits) {
    const day = Number(h.slice(8, 10))
    assert.ok(day >= 18 && day <= 24, `${h} hors fenêtre`)
  }
})

test('nextReminderDay : depuis un jour quelconque', () => {
  assert.equal(nextReminderDay('2026-08-02', OPTS), '2026-08-22')
  assert.equal(nextReminderDay('2026-08-22', OPTS), '2026-08-22') // inclusif
  assert.equal(nextReminderDay('2026-08-23', OPTS), '2026-09-22')
})

test('buildReminderMessage : date cible et délai', () => {
  const msg = buildReminderMessage({ dayIso: '2026-09-22', cards: 'Visa CAD, Visa USD', ...OPTS })
  assert.match(msg, /Visa CAD, Visa USD/)
  assert.match(msg, /dans 2 j/)
  assert.match(msg, /jeudi 24 septembre/)
  const sameDay = buildReminderMessage({ dayIso: '2026-10-24', cards: 'Visa', ...OPTS })
  assert.match(sameDay, /aujourd'hui/)
})
