import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeText, nameTokens, nameMatch, scoreInvoice } from './bankInvoiceMatch.js'

test('normalizeText efface accents et ponctuation', () => {
  assert.equal(normalizeText('Les Serres Décembre inc.'), 'LES SERRES DECEMBRE INC')
})

test('nameTokens écarte les mots qui ne distinguent personne', () => {
  assert.deepEqual(nameTokens('Les Fermes Décembre inc.'), ['DECEMBRE'])
})

test('nameMatch reconnaît un nom tronqué par la banque', () => {
  const m = nameMatch('Biotalent Canada', 'COMPTES DEBITEURS BIOTALENT CANAD')
  assert.equal(m.hits, 1)
  assert.equal(m.ratio, 1)
})

test('nameMatch reste muet quand rien ne concorde', () => {
  assert.equal(nameMatch('Premier Tech', 'DEBOURSE MCR 060024937974').hits, 0)
})

const txn = { amount: 1177.47, txn_date: '2026-09-18', account_currency: 'CAD' }
const ctx = { amountCad: 1177.47, rate: 1.38, text: 'COMPTES DEBITEURS BIOTALENT CANAD' }

test('montant exact et nom au relevé donnent une note haute', () => {
  const r = scoreInvoice(txn, {
    company_name: 'Biotalent Canada', document_number: 'ABC-0001',
    total_amount: 1177.47, balance_due: 1177.47, currency: 'CAD', document_date: '2026-09-01',
  }, ctx)
  assert.ok(r.score >= 85, `score ${r.score}`)
  assert.ok(r.reasons.includes('montant exact'))
  assert.ok(r.reasons.includes('nom du payeur au relevé'))
})

test('même montant mais autre client : note nettement plus basse', () => {
  const r = scoreInvoice(txn, {
    company_name: 'Premier Tech', document_number: 'XYZ-0009',
    total_amount: 1177.47, balance_due: 1177.47, currency: 'CAD', document_date: '2026-09-01',
  }, ctx)
  assert.ok(r.score < 85, `score ${r.score}`)
})

test('facture postérieure au dépôt est pénalisée', () => {
  const r = scoreInvoice(txn, {
    company_name: 'Biotalent Canada', document_number: 'ABC-0002',
    total_amount: 1177.47, balance_due: 1177.47, currency: 'CAD', document_date: '2026-10-05',
  }, ctx)
  assert.ok(r.reasons.includes('facture postérieure au dépôt'))
})

test('facture USD retrouvée par le montant converti', () => {
  const r = scoreInvoice(txn, {
    company_name: 'Venn Software', document_number: 'USD-0003',
    total_amount: 853.24, balance_due: 853.24, currency: 'USD', document_date: '2026-09-10',
  }, ctx)
  assert.ok(r.reasons.some(x => x.startsWith('montant exact une fois converti')), r.reasons.join('|'))
})

test('numéro de facture écrit dans la référence', () => {
  const r = scoreInvoice({ ...txn, amount: 50 }, {
    company_name: 'Inconnue', document_number: 'QITB2ZCG-0003',
    total_amount: 999, balance_due: 999, currency: 'CAD', document_date: '2026-09-01',
  }, { amountCad: 50, rate: 1.38, text: 'VIREMENT QITB2ZCG 0003' })
  assert.ok(r.reasons.includes('numéro de facture au relevé'))
})
