import { test } from 'node:test'
import assert from 'node:assert'
import XLSX from 'xlsx'
import {
  monthBounds, previousMonth, driveFileName, monthLabel,
  piecesSlackText, buildPiecesWorkbook,
} from './piecesDisbursements.js'

test('monthBounds couvre le mois entier, années bissextiles comprises', () => {
  assert.deepStrictEqual(monthBounds('2026-07'), { start: '2026-07-01', end: '2026-07-31' })
  assert.deepStrictEqual(monthBounds('2026-02'), { start: '2026-02-01', end: '2026-02-28' })
  assert.deepStrictEqual(monthBounds('2024-02'), { start: '2024-02-01', end: '2024-02-29' })
})

test('previousMonth traverse le changement d\'année', () => {
  assert.strictEqual(previousMonth('2026-07'), '2026-06')
  assert.strictEqual(previousMonth('2026-01'), '2025-12')
})

test('driveFileName suit la convention des mois précédents', () => {
  assert.strictEqual(driveFileName('2026-07'), 'Pièces_Déboursés_Juillet26')
  assert.strictEqual(driveFileName('2026-03'), 'Pièces_Déboursés_Mars26')
  assert.strictEqual(monthLabel('2026-07'), 'Juillet 2026')
})

test('le message Slack porte le montant formaté et le lien vers l\'ERP', () => {
  const text = piecesSlackText({
    month: '2026-07', debourses: 4238.78,
    drive_url: 'https://docs.google.com/x', drive_name: 'Pièces_Déboursés_Juillet26',
  })
  assert.match(text, /^Mon général :saluting_face:/)
  // Intl fr-CA sépare les milliers par une espace insécable étroite, pas par
  // une espace ordinaire — \s le couvre sans figer le point de code.
  assert.match(text, /déboursés du mois de juillet en pièces correspondent à 4\s238,78 \$\./)
  assert.match(text, /<https:\/\/customer\.orisha\.io\/erp\/fin-de-mois\|Déboursés de pièces>/)
})

test('le lien vers l\'ERP est présent même sans fichier Drive généré', () => {
  const text = piecesSlackText({ month: '2026-07', debourses: 100, drive_url: null })
  assert.match(text, /<https:\/\/customer\.orisha\.io\/erp\/fin-de-mois\|Déboursés de pièces>/)
})

// Le bloc sommaire est ce que le comptable lit en premier : il doit reproduire
// la structure des fichiers des mois précédents (Achats + début − fin = déboursés).
test('le classeur reproduit le bloc sommaire de la procédure', () => {
  const state = {
    month: '2026-07',
    lines: [
      { date: '2026-07-06', type: 'Dépense', doc_num: '1', name: 'Digikey', memo: 'x', split_acc: '22000', amount: 100 },
      { date: '2026-07-10', type: 'Facture à payer', doc_num: '2', name: 'Dubois', memo: 'y', split_acc: '21000', amount: 50 },
    ],
    unpaid_lines: [{ name: 'Dubois', doc_num: '2', amount: 50 }],
    achats: 150, a_payer_debut: 20, a_payer_fin: 50, debourses: 120,
  }
  const ws = buildPiecesWorkbook(state).Sheets['Déboursés']
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true })
  const labels = rows.flat().filter(v => typeof v === 'string')

  assert.ok(labels.includes('Achats du mois'))
  assert.ok(labels.includes('(+) À payer au début'))
  assert.ok(labels.includes('(-) À payer à la fin'))
  assert.ok(labels.includes('Déboursés du mois'))
  assert.ok(labels.includes('À payer - fin du mois'))

  // « À payer à la fin » est inscrit en NÉGATIF — la procédure l'exige, et
  // c'est ce qui rend la somme du bloc égale aux déboursés.
  const findRow = label => rows.find(r => r.includes(label))
  assert.strictEqual(findRow('(+) À payer au début')[6], 20)
  assert.strictEqual(findRow('(-) À payer à la fin')[6], -50)

  // Les totaux sont des formules, pas des constantes : corriger une ligne dans
  // le Sheet doit recalculer le déboursé.
  const rowOf = label => rows.findIndex(r => r.includes(label)) + 1
  const achatsRow = rowOf('Achats du mois')
  const deboursesRow = rowOf('Déboursés du mois')
  assert.strictEqual(ws[`G${achatsRow}`]?.f, 'SUM(G2:G3)', 'Achats du mois doit être une somme des lignes')
  assert.strictEqual(ws[`G${deboursesRow}`]?.f, `SUM(G${achatsRow}:G${achatsRow + 2})`, 'Déboursés du mois doit sommer le bloc')
})
