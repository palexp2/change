import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeText, nameTokens, nameMatch, bestNameMatch, containsCompact, bankText, daysBetween, governmentLabelHit } from './textMatch.js'

test('normalizeText enlève accents et ponctuation', () => {
  assert.equal(normalizeText('Ferme Décembre inc.'), 'FERME DECEMBRE INC')
})

test('nameTokens écarte les mots vides et les fragments courts', () => {
  assert.deepEqual(nameTokens('Les Serres de la Ferme Décembre inc.'), ['DECEMBRE'])
})

test('nameMatch tolère la troncature du relevé', () => {
  const m = nameMatch('Biotalent Canada', 'VIREMENT BIOTALENT CANAD 0043')
  assert.equal(m.hits, 1)
  assert.equal(m.ratio, 1)
})

test('bestNameMatch retient l’alias qui colle', () => {
  const b = bestNameMatch(['Digi-Key Corporation', 'DKC'], 'ACHAT DKC 8829')
  assert.equal(b.name, 'DKC')
  assert.ok(b.ratio >= 1)
})

test('containsCompact reconnaît un nom collé au relevé', () => {
  assert.equal(containsCompact('PAIEMENT DIGIKEY CORP', 'Digi-Key'), true)
  assert.equal(containsCompact('PAIEMENT ABC', 'ABC'), false)
})

test('bankText concatène ce que la banque écrit', () => {
  assert.equal(bankText({ description: 'A', details: null, reference: 'B' }), 'A B')
})

test('daysBetween compte les jours civils', () => {
  assert.equal(daysBetween('2026-09-01', '2026-09-11'), 10)
  assert.equal(daysBetween(null, '2026-09-11'), null)
})

test('governmentLabelHit : libellés usuels de l’ARC et de Revenu Québec', () => {
  const arc = ['Agence du revenu du Canada']
  for (const t of ['REMB. IMPOT CANADA', 'GOUV. CANADA', 'CANADA FED', 'CRA/ARC 1234', 'TAX REFUND']) {
    assert.equal(governmentLabelHit(arc, t), true, t)
  }
  assert.equal(governmentLabelHit(['Revenu Québec'], 'MRQ REMB'), true)
  assert.equal(governmentLabelHit(['Revenu Québec'], 'REVENU QUEBEC TPS'), true)
  // Un libellé propre au fédéral ne désigne pas Québec, et l'inverse.
  assert.equal(governmentLabelHit(['Revenu Québec'], 'CANADA FED'), false)
  assert.equal(governmentLabelHit(arc, 'MRQ'), false)
  // Un fournisseur ordinaire n'hérite jamais de ces libellés.
  assert.equal(governmentLabelHit(['Digi-Key Corporation'], 'REMB. IMPOT CANADA'), false)
  // « ARC » doit être un mot entier, pas un morceau.
  assert.equal(governmentLabelHit(arc, 'MARCHE PUBLIC'), false)
})
