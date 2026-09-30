import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextRecurringStatements } from './treasuryRecurringAmounts.js'

const statement = (date, amount, id = 'mastercard') => ({ id, date, amount })
const projection = (statements, events = []) => ({
  days: [{ date: '2026-09-27', events }], card_statements: statements,
})

test('choisit le montant de la prochaine échéance, indépendamment de l’ordre des relevés', () => {
  const data = projection([statement('2026-11-05', 6000), statement('2026-10-05', 5296)])
  assert.equal(nextRecurringStatements(data).get('mastercard').amount, 5296)
  assert.equal(data.card_statements[0].date, '2026-11-05')
})

test('écarte un ancien relevé, mais conserve une échéance en retard encore due', () => {
  const data = projection([statement('2026-09-05', 1072.86), statement('2026-10-05', 5296)])
  assert.equal(nextRecurringStatements(data).get('mastercard').amount, 5296)
  data.days[0].events.push({ kind: 'recurring', ref: 'mastercard', date: '2026-09-27', original_date: '2026-09-05' })
  assert.equal(nextRecurringStatements(data).get('mastercard').amount, 1072.86)
})

test('ne reprend pas une échéance confirmée passée au compte', () => {
  const data = projection([statement('2026-09-27', 1072.86), statement('2026-10-05', 5296)])
  data.auto_cleared = [{ kind: 'recurring', ref: 'mastercard', original_date: '2026-09-27' }]
  assert.equal(nextRecurringStatements(data).get('mastercard').amount, 5296)
})

test('conserve un relevé à zéro et distingue les cartes', () => {
  const data = projection([statement('2026-10-05', 0), statement('2026-10-10', 200, 'visa')])
  const amounts = nextRecurringStatements(data)
  assert.equal(amounts.get('mastercard').amount, 0)
  assert.equal(amounts.get('visa').amount, 200)
})

test('sans relevé, laisse l’affichage utiliser l’historique ou la saisie', () => {
  assert.equal(nextRecurringStatements(null).size, 0)
  assert.equal(nextRecurringStatements(projection([])).size, 0)
})
