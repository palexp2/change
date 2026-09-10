import test from 'node:test'
import assert from 'node:assert/strict'
import { parsePrintedNumber, totalCandidates, verdictForAmount } from './saleReceiptAmountCheck.js'

test('parsePrintedNumber — séparateurs FR et EN', () => {
  assert.equal(parsePrintedNumber('76,28'), 76.28)
  assert.equal(parsePrintedNumber('76.28'), 76.28)
  assert.equal(parsePrintedNumber('1 234,56'), 1234.56)
  assert.equal(parsePrintedNumber('1,234.56'), 1234.56)
  assert.equal(parsePrintedNumber('$ 1 234,56'), 1234.56)
  assert.equal(parsePrintedNumber('(76,28)'), -76.28)
  assert.equal(parsePrintedNumber('12'), 12)
  assert.equal(parsePrintedNumber('abc'), null)
})

test('totalCandidates — ignore sous-total et totaux de taxes', () => {
  const text = [
    'Sous-total                 66,34',
    'Total des taxes             9,94',
    'Total TPS                   3,32',
    'Montant total dû           76,28',
  ].join('\n')
  const c = totalCandidates(text)
  assert.equal(c.length, 1)
  assert.equal(c[0].amount, 76.28)
  assert.equal(c[0].weight, 3)
})

test('verdictForAmount — montant confirmé sur la ligne de total', () => {
  const text = 'Sous-total 66,34\nTPS 3,32\nTVQ 6,62\nTotal à payer 76,28'
  const v = verdictForAmount(text, 76.28)
  assert.equal(v.status, 'confirmed')
  assert.equal(v.document_total, 76.28)
})

test('verdictForAmount — écart avec le total du document', () => {
  const text = 'Sous-total 66,34\nTPS 3,32\nTVQ 6,62\nMontant dû 96,28'
  const v = verdictForAmount(text, 76.28)
  assert.equal(v.status, 'mismatch')
  assert.equal(v.document_total, 96.28)
})

test('verdictForAmount — tolérance de 2 cents', () => {
  assert.equal(verdictForAmount('Total à payer 76,28', 76.29).status, 'confirmed')
  assert.equal(verdictForAmount('Total à payer 76,28', 76.35).status, 'mismatch')
})

test('verdictForAmount — plusieurs lignes de total (facture télécom)', () => {
  const text = [
    'Total frais courants 47,77',
    'Total frais courants 53,52',
    'Total à payer 196,83',
  ].join('\n')
  assert.equal(verdictForAmount(text, 196.83).status, 'confirmed')
  assert.equal(verdictForAmount(text, 47.77).status, 'confirmed')
  assert.equal(verdictForAmount(text, 222.46).document_total, 196.83)
})

test('verdictForAmount — sans ligne de total, cherche le montant dans le texte', () => {
  const text = 'MERCI DE VOTRE VISITE\n76,28 $ VISA\nAPPROUVÉ'
  assert.equal(verdictForAmount(text, 76.28).status, 'confirmed')
  assert.equal(verdictForAmount(text, 44.10).status, 'mismatch')
})

test('verdictForAmount — sans texte ni montant : inconnu', () => {
  assert.equal(verdictForAmount('', 76.28).status, 'unknown')
  assert.equal(verdictForAmount('Total à payer 76,28', 0).status, 'unknown')
})

test('totalCandidates — ignore les nombres qui ne sont pas des montants', () => {
  // Numéro de TVQ sur la ligne du libellé, montant imprimé en dessous.
  const c = totalCandidates('QST ID: 1225394756TQ0001            Total Due\n            $982.77')
  assert.equal(c.length, 1)
  assert.equal(c[0].amount, 982.77)
  // En-tête de vieillissement de compte : aucun montant.
  assert.equal(totalCandidates('Courant   30 Jours   60 Jours   90 Jours   Total').length, 0)
})

test('verdictForAmount — « Total » générique non concluant : la présence fait foi', () => {
  const text = '113 Total de la valeur en douane   787,46\nHonoraires de courtage   43,69'
  assert.equal(verdictForAmount(text, 43.69).status, 'confirmed')
})

test('verdictForAmount — PDF de plusieurs factures : le reçu porte leur somme', () => {
  const text = 'Total à payer: $57.00\n...\nTotal à payer: $11.49\n...\nTotal à payer: $19.53'
  const v = verdictForAmount(text, 88.02)
  assert.equal(v.status, 'confirmed')
  assert.equal(verdictForAmount(text, 75.91).status, 'mismatch')
})

test('totalCandidates — montant en colonne de droite avec un taux dans le libellé', () => {
  const c = totalCandidates('Total (taxes incluses)            1 234,56')
  assert.equal(c[0].amount, 1234.56)
})
