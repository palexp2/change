import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTab, canonicalProject, cellDate, weekEntryDays } from './rdTimesheetSheetSync.js'

// Onglet tel que lu dans feuille_de_temps_9_2026 (Alicia).
const ROWS = [
  ['Alicia Talbot-Lanciault', '', '', ''],
  ['Dates', 'Heures RSDE', 'Description RSDE', 'Projet'],
  ['2026/09/01', 8, 'Sortie de 3.34.1', 'Fiabilité'],
  ['2026/09/03', 0, 'Congé', ''],
  ['2026/09/07', '6.4', 'Congé férié', 'fiabilite'],
  [46282, 8, 'Inspection algo', 'Intelligence de contrôle'],
  ['total', 22.4, '', ''],
]

test('parseTab : colonnes par en-tête, une ligne par jour, numéro de ligne réel', () => {
  const t = parseTab(ROWS, 1)
  assert.equal(t.cols.hours, 1)
  assert.equal(t.cols.project, 3)
  assert.deepEqual(t.days.get('2026-09-01'), { row: 3, hours: 8, desc: 'Sortie de 3.34.1', project: 'Fiabilité' })
  assert.equal(t.days.get('2026-09-07').hours, 6.4)
  assert.equal(t.days.get('2026-09-07').project, 'Fiabilité')
  assert.equal(t.days.get(cellDate(46282)).project, 'Intelligence de contrôle')
  assert.equal(t.days.has('total'), false)
})

test('parseTab : onglet sans colonne « Heures RSDE » → null', () => {
  assert.equal(parseTab([['Nom'], ['a', 'b']]), null)
})

test('canonicalProject', () => {
  assert.equal(canonicalProject('intelligence de controle'), 'Intelligence de contrôle')
  assert.equal(canonicalProject(''), '')
  assert.equal(canonicalProject('Autre'), 'Autre')
})

test('weekEntryDays : semaine répartie du lundi au vendredi, jour attitré conservé', () => {
  assert.deepEqual(weekEntryDays('2026-10-04', null, 602), [
    ['2026-10-05', 121], ['2026-10-06', 121], ['2026-10-07', 120], ['2026-10-08', 120], ['2026-10-09', 120],
  ])
  assert.deepEqual(weekEntryDays('2026-10-04', '2026-10-07', 90), [['2026-10-07', 90]])
})
