// Ce que le libellé du relevé dit en clair — fonctions pures, aucune base.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractForeignAmount, extractCheckNumber, txnFacts } from './bankTxnFacts.js'

describe('extractForeignAmount', () => {
  it('lit le montant d\'origine du relevé BNC (virgule décimale)', () => {
    assert.deepEqual(
      extractForeignAmount('WIX.COM 1246866409     SAN FRANCISCO CA  USA CA Montant initial en devise USD 37,49'),
      { currency: 'USD', amount: 37.49 },
    )
  })

  it('tolère les milliers espacés', () => {
    assert.deepEqual(extractForeignAmount('ACME Montant initial en devise USD 1 234,56'), { currency: 'USD', amount: 1234.56 })
  })

  it('ne trouve rien sur une ligne canadienne ordinaire', () => {
    assert.equal(extractForeignAmount('GOOGLE *SERVICES HALIFAX NS CAN NS'), null)
    assert.equal(extractForeignAmount(''), null)
    assert.equal(extractForeignAmount(null), null)
  })

  it('refuse un montant nul plutôt que d\'annoncer un taux impossible', () => {
    assert.equal(extractForeignAmount('X Montant initial en devise USD 0,00'), null)
  })
})

describe('extractCheckNumber', () => {
  it('lit le numéro dans le libellé', () => {
    assert.equal(extractCheckNumber('CHEQUE NO 15', 'CT Greenhouse'), '15')
  })

  it('va le chercher en référence quand le libellé s\'arrête à « CHEQUE NO »', () => {
    assert.equal(extractCheckNumber('CHEQUE NO', '18'), '18')
  })

  it('ne prend pas une référence qui n\'est pas un numéro', () => {
    assert.equal(extractCheckNumber('CHEQUE NO', 'CT Greenhouse'), null)
  })

  it('ne voit pas de chèque là où il n\'y en a pas', () => {
    assert.equal(extractCheckNumber('VIREMENT INTERAC', '22'), null)
  })
})

describe('txnFacts', () => {
  it('préfère les colonnes au libellé quand elles sont remplies', () => {
    const f = txnFacts({ description: 'X Montant initial en devise USD 10,00', orig_currency: 'EUR', orig_amount: -5, check_number: '99' })
    assert.deepEqual(f.foreign, { currency: 'EUR', amount: -5 })
    assert.equal(f.check, '99')
  })

  it('relit le libellé pour une ligne importée avant ces colonnes', () => {
    const f = txnFacts({ description: 'OPENAI SAN FRANCISCO CA USA CA Montant initial en devise USD 11,48', reference: 'Z074335964' })
    assert.deepEqual(f.foreign, { currency: 'USD', amount: 11.48 })
    assert.equal(f.check, null)
  })
})
