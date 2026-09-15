// Montant d'un paiement de carte lu sur le relevé de la carte.
//
// Les cas viennent du vrai compte MasterCard BNC : c'est là que les pièges
// vivent (remboursement ponctuel au milieu d'une période, virement mensuel qui
// règle le relevé précédent).
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { statementPeriod } from './cardStatement.js'

describe('statementPeriod', () => {
  test('un paiement du début du mois règle le relevé fermé le mois précédent', () => {
    // Paiement du 5 octobre, relevé fermé le 14 → achats du 15 août au 14 sept.
    assert.deepEqual(statementPeriod('2026-10-05', 14), { from: '2026-08-14', to: '2026-09-14' })
    assert.deepEqual(statementPeriod('2026-09-04', 14), { from: '2026-07-14', to: '2026-08-14' })
  })

  test('un paiement postérieur à la fermeture règle le relevé du mois même', () => {
    assert.deepEqual(statementPeriod('2026-09-20', 14), { from: '2026-08-14', to: '2026-09-14' })
  })

  test('passage d\'année', () => {
    assert.deepEqual(statementPeriod('2027-01-05', 14), { from: '2026-11-14', to: '2026-12-14' })
  })

  test('sans jour de fermeture, aucune période', () => {
    assert.equal(statementPeriod('2026-10-05', 0), null)
    assert.equal(statementPeriod('pas une date', 14), null)
  })
})

describe('parseStatementHeader', () => {
  test('lit la date du relevé, le solde et l\'échéance', async () => {
    const { parseStatementHeader } = await import('./cardStatementImport.js')
    // En-tête réel du relevé du 16 août 2026 : le solde imprimé est exactement
    // ce qui a été prélevé au compte le 4 septembre.
    const h = parseStatementHeader('   26 08 16     $1,724.69     $1,724.69 2026 09 08')
    assert.deepEqual(h, { statement_date: '2026-08-16', balance: 1724.69, due_date: '2026-09-08' })
  })

  test('un relevé illisible ne produit pas de montant inventé', async () => {
    const { parseStatementHeader } = await import('./cardStatementImport.js')
    assert.equal(parseStatementHeader('AUTOMATISATION ORISHA INC'), null)
    assert.equal(parseStatementHeader(''), null)
  })
})
