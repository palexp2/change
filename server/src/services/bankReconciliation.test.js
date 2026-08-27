import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseAmount, parseTxnDate, parseStatementText, labelMatchesVendor, deriveStatus,
} from './bankReconciliation.js'

// ── parseAmount ──────────────────────────────────────────────────────────────

test('parseAmount : formats bancaires courants', () => {
  assert.equal(parseAmount('20 000,00'), 20000)
  assert.equal(parseAmount('1,234.56'), 1234.56)
  assert.equal(parseAmount('(75.42)'), -75.42)
  assert.equal(parseAmount('-75,42 $'), -75.42)
  assert.equal(parseAmount('73.51CR'), 73.51)
  assert.equal(parseAmount('4 311,27'), 4311.27)
  assert.equal(parseAmount(''), null)
  assert.equal(parseAmount('Description'), null)
})

// ── parseTxnDate ─────────────────────────────────────────────────────────────

test('parseTxnDate : ISO, jj/mm/aaaa, mois français et anglais', () => {
  assert.equal(parseTxnDate('2026-07-27'), '2026-07-27')
  assert.equal(parseTxnDate('27/07/2026'), '2026-07-27')
  assert.equal(parseTxnDate('27 juil. 2026'), '2026-07-27')
  assert.equal(parseTxnDate('Mon Jul 27 2026 00:00:00 GMT-0400'), '2026-07-27')
  assert.equal(parseTxnDate('Jul 27, 2026'), '2026-07-27')
  assert.equal(parseTxnDate('Solde'), null)
  assert.equal(parseTxnDate(''), null)
})

// ── parseStatementText ───────────────────────────────────────────────────────

test('parseStatementText : relevé BNC avec Débit/Crédit', () => {
  const text = [
    'Date\tDescription\tRéférence\tDébit\tCrédit\tSolde',
    '2026-07-27\tREMB. MCR\t60024937974\t\t73,00\t73,51',
    '2026-07-27\tCOMPTE DIVERS\t\t910,88\t\t188,28',
  ].join('\n')
  const { rows, errors } = parseStatementText(text)
  assert.equal(errors.length, 0)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].amount, 73)
  assert.equal(rows[1].amount, -910.88)
  assert.equal(rows[1].description, 'COMPTE DIVERS')
})

test('parseStatementText : relevé carte avec colonne Montant signée', () => {
  const text = [
    'Date\tDescription\tMontant\tSolde',
    '27/07/2026\tAMAZON.CA*W54QM9K83\t-27.95\t1961.10',
    '23/07/2026\tANTHROPIC* CLAUDE SUB\t113.76\t1933.15',
  ].join('\n')
  const { rows } = parseStatementText(text)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].amount, -27.95)
  assert.equal(rows[1].amount, 113.76)
})

test('parseStatementText : lignes de légende ignorées sans erreur, entêtes requises', () => {
  const withNoise = 'Factures retracées\nDate\tDescription\tMontant\n2026-07-01\tX\t-1,00'
  const { rows, errors } = parseStatementText(withNoise)
  assert.equal(rows.length, 1)
  assert.equal(errors.length, 0)
  const noHeader = parseStatementText('2026-07-01\tX\t-1,00')
  assert.equal(noHeader.rows.length, 0)
  assert.equal(noHeader.errors.length, 1)
})

// ── labelMatchesVendor ───────────────────────────────────────────────────────

test('labelMatchesVendor : troncatures et compactions des relevés', () => {
  assert.equal(labelMatchesVendor('DKC*DIGI-KEY CORP      TH', 'Digi-Key'), true)
  assert.equal(labelMatchesVendor('ANTHROPIC* CLAUDE SUB  SA', 'Anthropic'), true)
  assert.equal(labelMatchesVendor('AMAZON.CA*W54QM9K83    TO', 'Amazon'), true)
  assert.equal(labelMatchesVendor('COMPTE DIVERS STRIPE', 'Bell Canada'), false)
  assert.equal(labelMatchesVendor('PAIEMENT FACTURE', 'Novoxpress', ['NOVO EXPRESS']), false)
  assert.equal(labelMatchesVendor('NOVOEXPRESS QUEBEC', 'Novoxpress inc.', ['Novo Express']), true)
})

// ── deriveStatus (parties pures : ignore / rapproché / non apparié) ──────────

test('deriveStatus : priorités ignore > rapproché > non apparié', () => {
  assert.equal(deriveStatus({ status: 'ignore' }), 'ignore')
  assert.equal(deriveStatus({ status: 'a_traiter', reconciled_at: '2026-07-28T00:00:00Z' }), 'rapproche')
  assert.equal(deriveStatus({ status: 'a_traiter', matched_id: null }), 'a_traiter')
})
