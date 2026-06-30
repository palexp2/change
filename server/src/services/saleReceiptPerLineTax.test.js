// Codes de taxe PAR LIGNE publiés sur QuickBooks (comme dans QB où chaque ligne porte
// son propre code de taxe). Couvre :
//  - buildReceiptLines : chaque article avec tax_code_id reçoit son TaxCodeRef, les
//    autres réutilisent le détail global (identité préservée — rétro-compatibilité).
//  - aggregateLineTaxLines : la taxe de chaque ligne est calculée d'après les taux de
//    SON code, puis cumulée par TaxRate (ex. reçu repas + pourboire hors-champ).

import test from 'node:test'
import assert from 'node:assert/strict'

const { buildReceiptLines, aggregateLineTaxLines } = await import('./quickbooks.js')

// ── buildReceiptLines : TaxCodeRef par ligne ────────────────────────────────────
const BASE = { AccountRef: { value: '42' }, TaxCodeRef: { value: 'DOC' } }

test('chaque article avec tax_code_id reçoit son propre TaxCodeRef', () => {
  const items = [
    { description: 'Repas', total: 100, tax_code_id: '15' },
    { description: 'Pourboire', total: 15, tax_code_id: '2' },
  ]
  const lines = buildReceiptLines(items, 115, { lineDetail: BASE })
  assert.equal(lines.length, 2)
  assert.equal(lines[0].AccountBasedExpenseLineDetail.TaxCodeRef.value, '15')
  assert.equal(lines[1].AccountBasedExpenseLineDetail.TaxCodeRef.value, '2')
  // Le compte de dépense est conservé sur chaque ligne dérivée.
  assert.equal(lines[0].AccountBasedExpenseLineDetail.AccountRef.value, '42')
})

test('sentinel « aucune taxe » → ligne SANS TaxCodeRef même si le détail global en a un', () => {
  const items = [
    { description: 'Repas', total: 100, tax_code_id: '15' },
    { description: 'Sans taxe', total: 35, tax_code_id: '__none__' },
  ]
  const lines = buildReceiptLines(items, 135, { lineDetail: BASE })
  assert.equal(lines[0].AccountBasedExpenseLineDetail.TaxCodeRef.value, '15')
  // La ligne « aucune taxe » ne doit hériter d'AUCUN code (pas le 'DOC' global).
  assert.equal(lines[1].AccountBasedExpenseLineDetail.TaxCodeRef, undefined)
  assert.equal(lines[1].AccountBasedExpenseLineDetail.AccountRef.value, '42')
})

test('article sans tax_code_id réutilise le détail global (identité)', () => {
  const items = [
    { description: 'A', total: 50, tax_code_id: '9' },
    { description: 'B', total: 50 },
  ]
  const lines = buildReceiptLines(items, 100, { lineDetail: BASE })
  assert.equal(lines[0].AccountBasedExpenseLineDetail.TaxCodeRef.value, '9')
  // La ligne sans override doit pointer sur le détail global tel quel.
  assert.equal(lines[1].AccountBasedExpenseLineDetail, BASE)
  assert.equal(lines[1].AccountBasedExpenseLineDetail.TaxCodeRef.value, 'DOC')
})

// ── aggregateLineTaxLines : cumul par taux ──────────────────────────────────────
test('reçu mixte repas + pourboire hors-champ → taxe seulement sur le repas', () => {
  const lines = [
    { amount: 100, taxCodeId: 'repas' },
    { amount: 15, taxCodeId: 'horschamp' },
  ]
  const ratesByCode = new Map([
    ['repas', [{ id: 'r-tps', percent: 5 }, { id: 'r-tvq', percent: 9.975 }]],
    ['horschamp', []],
  ])
  const { taxLines, totalTax } = aggregateLineTaxLines(lines, ratesByCode)
  assert.equal(taxLines.length, 2, 'TPS + TVQ uniquement (le pourboire ne génère aucune taxe)')
  const byRate = Object.fromEntries(taxLines.map(l => [l.TaxLineDetail.TaxRateRef.value, l]))
  assert.equal(byRate['r-tps'].Amount, 5)
  assert.equal(byRate['r-tps'].TaxLineDetail.NetAmountTaxable, 100)
  assert.equal(byRate['r-tvq'].Amount, 9.98) // round2(100 * 9.975%)
  assert.equal(totalTax, 14.98)
})

test('même code sur plusieurs lignes → cumul net et taxe', () => {
  const lines = [
    { amount: 60, taxCodeId: 'tps' },
    { amount: 40, taxCodeId: 'tps' },
  ]
  const ratesByCode = new Map([['tps', [{ id: 'g', percent: 5 }]]])
  const { taxLines, totalTax } = aggregateLineTaxLines(lines, ratesByCode)
  assert.equal(taxLines.length, 1)
  assert.equal(taxLines[0].Amount, 5)             // 3 + 2
  assert.equal(taxLines[0].TaxLineDetail.NetAmountTaxable, 100)
  assert.equal(totalTax, 5)
})

test('lignes toutes hors-champ → aucune TaxLine, totalTax 0', () => {
  const lines = [{ amount: 20, taxCodeId: 'hc' }, { amount: 5, taxCodeId: 'hc' }]
  const ratesByCode = new Map([['hc', []]])
  const { taxLines, totalTax } = aggregateLineTaxLines(lines, ratesByCode)
  assert.equal(taxLines.length, 0)
  assert.equal(totalTax, 0)
})

test('code inconnu (taux non résolus) → ligne ignorée sans planter', () => {
  const lines = [{ amount: 100, taxCodeId: 'absent' }]
  const { taxLines, totalTax } = aggregateLineTaxLines(lines, new Map())
  assert.equal(taxLines.length, 0)
  assert.equal(totalTax, 0)
})
