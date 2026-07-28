import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeProgrammationDate, formatDateFr, locateProgrammationBlock,
  locateSection, parseAmountCell, findProgrammationLineToRemove,
} from './ctbSheet.js'

// ── computeProgrammationDate : mardi (2) précédant strictement l'échéance ────

test('échéance un jeudi → le mardi précédent', () => {
  // 23/07/2026 = jeudi ; aujourd'hui bien avant
  const d = computeProgrammationDate('2026-07-23', 2, new Date(2026, 6, 1))
  assert.equal(formatDateFr(d), '21/07/2026')
})

test('échéance un mardi → le mardi PRÉCÉDENT (strictement avant)', () => {
  // 04/08/2026 = mardi → 28/07/2026 (comportement observé dans le fichier CTB)
  const d = computeProgrammationDate('2026-08-04', 2, new Date(2026, 6, 1))
  assert.equal(formatDateFr(d), '28/07/2026')
})

test('mardi précédent déjà passé → prochain mardi à venir', () => {
  // Échéance mercredi 15/07/2026, aujourd'hui jeudi 09/07 : mardi avant = 14/07 (futur) → 14/07
  let d = computeProgrammationDate('2026-07-15', 2, new Date(2026, 6, 9))
  assert.equal(formatDateFr(d), '14/07/2026')
  // Aujourd'hui vendredi 17/07 (échéance dépassée) : mardi avant = 14/07 (passé) → prochain mardi 21/07
  d = computeProgrammationDate('2026-07-15', 2, new Date(2026, 6, 17))
  assert.equal(formatDateFr(d), '21/07/2026')
})

test("aujourd'hui = le mardi calculé → conservé (on paie aujourd'hui)", () => {
  const d = computeProgrammationDate('2026-07-16', 2, new Date(2026, 6, 14))
  assert.equal(formatDateFr(d), '14/07/2026')
})

test('jour de paiement configurable (vendredi = 5)', () => {
  // Échéance jeudi 23/07/2026 → vendredi précédent = 17/07/2026
  const d = computeProgrammationDate('2026-07-23', 5, new Date(2026, 6, 1))
  assert.equal(formatDateFr(d), '17/07/2026')
})

test('sans échéance → null', () => {
  assert.equal(computeProgrammationDate(null), null)
  assert.equal(computeProgrammationDate(''), null)
  assert.equal(computeProgrammationDate('pas-une-date'), null)
})

// ── locateProgrammationBlock : grille répliquant l'onglet Sommaire réel ──────

// Colonnes A..I ; le bloc « PROGRAMMATION … » démarre en F (index 5).
const GRID = [
  [], // R1
  ['', 'FACTURES MANQUANTES (Autres):'], // R2
  ['', 'Fournisseur', '$', 'Compte', 'Date', 'Commentaires'], // R3
  ['', 'OPENAI *CHATGPT', '26,25', 'Master', '01/07/2026', 'À demander'], // R4
  [], [], [], [], // R5-R8
  ['', 'AUTRES POINTS:'], // R9
  ['', 'Sujet', '$', 'Compte', 'Date', 'Commentaires'], // R10
  [], [], // R11-R12
  ['', 'FACTURES PAYÉES CETTE SEMAINE :', '', '', '', 'PROGRAMMATION DES FACTURES À PAYER:'], // R13
  ['', 'Fournisseur', '$', 'Déboursé le', '', 'Fournisseur', '$', 'Dû le', 'Programmation du paiement'], // R14
  ['', 'Novo Express', '368,35', '17/07/2026', '', 'Axxess International – USD', '40 USD', '-', '-'], // R15
  ['', 'BTTH', '103,48', '15/07/2026', '', 'Novo Express', '267,85', '23/07/2026', '21/07/2026'], // R16
  ['', '', '', '', '', 'Axxess International – CAD', '103,48', '04/08/2026', '28/07/2026'], // R17
  ['', '', '', '', '', 'Dubois Agrinovation', '830,77', '09/08/2026', '07/07/2026'], // R18
]

test('localise le bloc Programmation dans la grille du Sommaire', () => {
  const block = locateProgrammationBlock(GRID)
  assert.ok(block, 'bloc introuvable')
  assert.equal(block.col, 5) // colonne F
  assert.equal(block.headerRow, 13) // R14 (0-based)
  assert.equal(block.firstEmptyRow, 18) // R19 : première cellule Fournisseur vide
  assert.equal(block.existing.length, 4)
  assert.deepEqual(block.existing[1], {
    vendor: 'Novo Express', amount: '267,85', due: '23/07/2026', prog: '21/07/2026',
  })
})

test('localisation insensible à la casse et aux accents', () => {
  const block = locateProgrammationBlock(GRID, 'programmation des factures a payer')
  assert.ok(block)
  assert.equal(block.col, 5)
})

test('ne matche pas la colonne « Fournisseur » du bloc FACTURES PAYÉES (colonne B)', () => {
  const block = locateProgrammationBlock(GRID)
  // Les lignes existantes viennent bien du bloc F..I, pas du bloc B..D
  assert.ok(block.existing.every(e => e.vendor !== 'BTTH'))
})

test('section absente → null', () => {
  assert.equal(locateProgrammationBlock([['', 'rien'], ['', 'ici']]), null)
})

// ── locateSection : bloc « Factures payées cette semaine » (3 colonnes) ──────

test('localise le bloc Factures payées (colonne B, 3 colonnes)', () => {
  const sec = locateSection(GRID, 'FACTURES PAYÉES CETTE SEMAINE', 3)
  assert.ok(sec, 'bloc introuvable')
  assert.equal(sec.col, 1) // colonne B
  assert.equal(sec.rows.length, 2)
  assert.deepEqual(sec.rows[0], ['Novo Express', '368,35', '17/07/2026'])
  assert.equal(sec.firstEmptyRow, 16) // R17 : cellule B vide
})

// ── parseAmountCell ──────────────────────────────────────────────────────────

test('parseAmountCell tolère les formats du fichier', () => {
  assert.equal(parseAmountCell('267,85'), 267.85)
  assert.equal(parseAmountCell('1 046,27'), 1046.27)
  assert.equal(parseAmountCell('267,85 $'), 267.85)
  assert.equal(parseAmountCell('(22,68)'), -22.68)
  assert.equal(parseAmountCell('40,00 USD'), 40)
  assert.equal(parseAmountCell('40 USD'), 40)
  assert.equal(parseAmountCell('830.77'), 830.77)
  assert.equal(parseAmountCell(''), null)
  assert.equal(parseAmountCell('-'), null)
  assert.equal(parseAmountCell('n/a'), null)
})

// ── findProgrammationLineToRemove ────────────────────────────────────────────

const EXISTING = [
  { vendor: 'Axxess International – USD', amount: '40 USD', due: '-', prog: '-' },
  { vendor: 'Novo Express', amount: '267,85', due: '23/07/2026', prog: '21/07/2026' },
  { vendor: 'Novo Express', amount: '381,61', due: '31/07/2026', prog: '28/07/2026' },
  { vendor: 'Dubois Agrinovation', amount: '830,77', due: '09/08/2026', prog: '07/07/2026' },
]

test('fournisseur unique → retiré même sans montant/échéance', () => {
  assert.equal(findProgrammationLineToRemove(EXISTING, { vendor: 'dubois agrinovation' }), 3)
})

test('fournisseur en double → départage par échéance', () => {
  assert.equal(findProgrammationLineToRemove(EXISTING, { vendor: 'Novo Express', dueCell: '31/07/2026' }), 2)
})

test('fournisseur en double sans échéance → départage par montant', () => {
  assert.equal(findProgrammationLineToRemove(EXISTING, { vendor: 'Novo Express', total: 267.85 }), 1)
})

test('fournisseur en double, ni échéance ni montant concluants → -1 (rien retiré)', () => {
  assert.equal(findProgrammationLineToRemove(EXISTING, { vendor: 'Novo Express', total: 999 }), -1)
})

test('fournisseur absent → -1', () => {
  assert.equal(findProgrammationLineToRemove(EXISTING, { vendor: 'BTTH', total: 103.48 }), -1)
})
