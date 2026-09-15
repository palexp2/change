// Le garde-fou : un motif trop banal est refusé, et une règle qui contredit ce
// qui a vraiment été comptabilisé n'est pas proposée d'office.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { patternStrength } from './verify.js'

describe('patternStrength', () => {
  it('accepte un nom de fournisseur', () => {
    assert.equal(patternStrength('novo express').ok, true)
    assert.equal(patternStrength('Anthropic').ok, true)
  })

  it('refuse ce qui attraperait n\'importe quoi', () => {
    assert.equal(patternStrength('paiement').ok, false)
    assert.equal(patternStrength('inc').ok, false)
    assert.equal(patternStrength('frais canada').ok, false)
    assert.equal(patternStrength('ups').ok, false)
    assert.equal(patternStrength('').ok, false)
  })

  it('dit pourquoi', () => {
    assert.match(patternStrength('virement').reason, /courant/)
    assert.match(patternStrength('abc').reason, /court/)
  })
})
