import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseGuess, guessSource } from './bankAiGuess.js'

const accounts = [{ id: '12', name: 'Logiciels', type: 'Expense' }, { id: '61', name: 'BNC', type: 'Bank' }]

test('garde un compte de la liste, borne la confiance', () => {
  const g = parseGuess('```json\n{"nature":"Abonnement logiciel","vendor":"Google","account_id":12,"memo":"Abonnement","confidence":1.4}\n```', accounts)
  assert.equal(g.account_id, '12')
  assert.equal(g.confidence, 1)
  assert.equal(guessSource(g), 'déduit : Abonnement logiciel')
})

test('un compte inventé ou une réponse illisible ne remplit rien', () => {
  assert.equal(parseGuess('{"account_id":"999","confidence":0.9}', accounts).account_id, null)
  assert.equal(parseGuess('pas du json', accounts), null)
})
