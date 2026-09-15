// Le même mouvement dans les deux langues de la banque : une règle écrite dans
// QuickBooks doit reconnaître le libellé de notre relevé, et l'inverse.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { patternVariants } from './glossary.js'
import { labelMatches } from './match.js'

describe('patternVariants', () => {
  it('donne la formulation de l\'autre langue', () => {
    assert.ok(patternVariants('MISCELLANEOUS ACC.').includes('compte divers'))
    assert.ok(patternVariants('COMPTE DIVERS').includes('miscellaneous acc'))
  })

  it('préfère l\'expression la plus longue', () => {
    // « payment received thank you » doit gagner sur « payment » seul.
    assert.ok(patternVariants('PAYMENT RECEIVED THANK YOU').includes('votre paiement merci'))
  })

  it('laisse intact ce qu\'elle ne connaît pas', () => {
    assert.deepEqual(patternVariants('NOVO EXPRESS'), ['novo express'])
  })
})

describe('labelMatches, en deux langues', () => {
  it('une règle QuickBooks attrape notre libellé français', () => {
    assert.equal(labelMatches('DT NETHRIS PAIE COMPTE DIVERS', 'MISCELLANEOUS ACC.'), true)
    assert.equal(labelMatches('VOTRE PAIEMENT - MERCI', 'PAYMENT RECEIVED THANK YOU'), true)
    assert.equal(labelMatches('Dépôt provenant de marge de crédit', 'deposit from line of credit'), true)
    assert.equal(labelMatches('Frais fixes d\'utilisation', 'Fixed service charges'), true)
  })

  it('ne rend pas la comparaison laxiste pour autant', () => {
    assert.equal(labelMatches('NOVO EXPRESS INC', 'MISCELLANEOUS ACC.'), false)
    assert.equal(labelMatches('COMPTE DIVERS', 'deposit from line of credit'), false)
  })
})
