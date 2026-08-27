// Sens de conversion de devise au push d'un reçu vers QB. La devise de la transaction
// est imposée par le fournisseur QB ; celle du reçu vient de l'extraction IA, qui peut
// se tromper quand la facture n'imprime qu'un « $ ». Seul le sens USD → CAD est converti.
// Cas Postmark (13 août 2026) : facture 15 $ US lue « CAD », fournisseur QB « Postmark USD »
// → 15 ÷ 1,3927 = 10,77 USD publiés. Ce sens est désormais bloqué.

import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveFxDirection } from './quickbooks.js'

test('même devise → aucune conversion', () => {
  assert.deepEqual(resolveFxDirection('CAD', 'CAD', 'Novo Express'), { convert: false, error: null })
  assert.deepEqual(resolveFxDirection('USD', 'USD', 'Twilio'), { convert: false, error: null })
})

test('reçu USD sur fournisseur QB CAD → converti (cas Slack)', () => {
  assert.deepEqual(resolveFxDirection('USD', 'CAD', 'Slack'), { convert: true, error: null })
})

test('reçu CAD sur fournisseur QB USD → bloqué (cas Postmark)', () => {
  const r = resolveFxDirection('CAD', 'USD', 'Postmark USD')
  assert.equal(r.convert, false)
  assert.match(r.error, /Postmark USD/)
  assert.match(r.error, /CAD→USD/)
})

test('devise non supportée → bloqué', () => {
  const r = resolveFxDirection('EUR', 'CAD', 'Fournisseur X')
  assert.equal(r.convert, false)
  assert.match(r.error, /non supportée/)
})

test('devise absente = CAD', () => {
  assert.deepEqual(resolveFxDirection(null, undefined, 'X'), { convert: false, error: null })
  assert.equal(resolveFxDirection(null, 'USD', 'X').convert, false)
  assert.ok(resolveFxDirection(null, 'USD', 'X').error)
})
