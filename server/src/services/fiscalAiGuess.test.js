import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseGuess } from './fiscalAiGuess.js'
import { taxSignature } from './fiscalDetection.js'

describe('parseGuess', () => {
  const noTax = taxSignature({ subtotal: 100, tps: 0, tvq: 0, other_taxes: 0 })
  const qc = taxSignature({ subtotal: 100, tps: 5, tvq: 9.98, other_taxes: 0 })
  it('garde un type cohérent avec les taxes', () => {
    assert.equal(parseGuess('{"transaction_type":"achat_local_taxable"}', qc), 'achat_local_taxable')
  })
  it('écarte un type taxable sur un document sans taxe', () => {
    assert.equal(parseGuess('{"transaction_type":"achat_local_taxable"}', noTax), null)
  })
  it('écarte une clé inconnue, un type de vente ou du JSON invalide', () => {
    assert.equal(parseGuess('{"transaction_type":"inconnu"}', qc), null)
    assert.equal(parseGuess('{"transaction_type":"vente_abo_qc"}', qc), null)
    assert.equal(parseGuess('pas du json', qc), null)
  })
})
