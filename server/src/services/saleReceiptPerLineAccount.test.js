// Compte de dépense PAR LIGNE publié sur QuickBooks (comme dans QB, où chaque ligne
// porte son propre compte) : certains achats concernent plus d'un compte de dépense
// (ex. pièces au stock 14000 + frais de transport). Une ligne sans compte propre suit
// le compte de dépense du document — l'objet de détail global est réutilisé tel quel.

import test from 'node:test'
import assert from 'node:assert/strict'

const { buildReceiptLines } = await import('./quickbooks.js')

const BASE = { AccountRef: { value: 'DOC-ACC' }, TaxCodeRef: { value: 'DOC-TAX' } }

test('chaque article avec expense_account_id reçoit son propre AccountRef', () => {
  const items = [
    { description: 'Pièces', total: 80, expense_account_id: '14000-id' },
    { description: 'Transport', total: 20, expense_account_id: '6240-id' },
  ]
  const lines = buildReceiptLines(items, 100, { lineDetail: BASE })
  assert.equal(lines.length, 2)
  assert.equal(lines[0].AccountBasedExpenseLineDetail.AccountRef.value, '14000-id')
  assert.equal(lines[1].AccountBasedExpenseLineDetail.AccountRef.value, '6240-id')
  // Le code de taxe du document reste hérité par les deux lignes.
  assert.equal(lines[0].AccountBasedExpenseLineDetail.TaxCodeRef.value, 'DOC-TAX')
  assert.equal(lines[1].AccountBasedExpenseLineDetail.TaxCodeRef.value, 'DOC-TAX')
})

test('article sans compte propre → compte du document (détail global réutilisé)', () => {
  const items = [
    { description: 'Pièces', total: 50, expense_account_id: '14000-id' },
    { description: 'Autre', total: 50 },
  ]
  const lines = buildReceiptLines(items, 100, { lineDetail: BASE })
  assert.equal(lines[0].AccountBasedExpenseLineDetail.AccountRef.value, '14000-id')
  assert.equal(lines[1].AccountBasedExpenseLineDetail, BASE)
  assert.equal(lines[1].AccountBasedExpenseLineDetail.AccountRef.value, 'DOC-ACC')
})

test('compte par ligne et code de taxe par ligne se combinent', () => {
  const items = [
    { description: 'Repas', total: 100, tax_code_id: 'repas', expense_account_id: '6510-id' },
    { description: 'Pourboire', total: 15, tax_code_id: '__none__', expense_account_id: '6510-id' },
  ]
  const lines = buildReceiptLines(items, 115, { lineDetail: BASE })
  assert.equal(lines[0].AccountBasedExpenseLineDetail.AccountRef.value, '6510-id')
  assert.equal(lines[0].AccountBasedExpenseLineDetail.TaxCodeRef.value, 'repas')
  assert.equal(lines[1].AccountBasedExpenseLineDetail.AccountRef.value, '6510-id')
  // Sentinel « aucune taxe » : la ligne ne doit hériter d'aucun TaxCodeRef.
  assert.equal(lines[1].AccountBasedExpenseLineDetail.TaxCodeRef, undefined)
  // Le détail global n'est jamais muté par les overrides.
  assert.equal(BASE.AccountRef.value, 'DOC-ACC')
  assert.equal(BASE.TaxCodeRef.value, 'DOC-TAX')
})

test('ligne unique de repli (aucun montant exploitable) → compte du document', () => {
  const items = [{ description: 'Service', total: 0, expense_account_id: '6240-id' }]
  const lines = buildReceiptLines(items, 40, { lineDetail: BASE, fallbackDescription: 'Acme' })
  assert.equal(lines.length, 1)
  assert.equal(lines[0].AccountBasedExpenseLineDetail.AccountRef.value, 'DOC-ACC')
})
