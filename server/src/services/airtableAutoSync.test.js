import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { convertValue } from './airtableAutoSync.js'

// Champs pourcentage Airtable : l'API renvoie une fraction (0.85 = « 85 % »).
// L'ERP stocke et affiche des points de pourcentage (0-100).
describe('convertValue — champ pourcentage', () => {
  test('fraction Airtable → points de pourcentage', () => {
    const opts = { format: 'percent' }
    assert.strictEqual(convertValue(0.85, 'number', opts), 85)
    assert.strictEqual(convertValue(0.7, 'number', opts), 70)
    assert.strictEqual(convertValue(1, 'number', opts), 100)
    assert.strictEqual(convertValue(0, 'number', opts), 0)
    assert.strictEqual(convertValue(0.01, 'number', opts), 1)
  })

  test('pas de bruit binaire', () => {
    assert.strictEqual(convertValue(0.07, 'number', { format: 'percent' }), 7)
    assert.strictEqual(convertValue(0.29, 'number', { format: 'percent' }), 29)
  })

  test('valeur absente → null', () => {
    assert.strictEqual(convertValue(null, 'number', { format: 'percent' }), null)
    assert.strictEqual(convertValue(undefined, 'number', { format: 'percent' }), null)
  })

  test('colonne pourcentage sans type de rendu (chemin webhook) convertie aussi', () => {
    // render_type absent → 'text' ; la conversion doit primer, sinon le webhook
    // réécrivait la fraction brute en texte ('0.7').
    assert.strictEqual(convertValue(0.7, 'text', { format: 'percent' }), 70)
  })

  test('les autres formats numériques ne sont pas touchés', () => {
    assert.strictEqual(convertValue(0.85, 'number', { format: 'currency' }), 0.85)
    assert.strictEqual(convertValue(0.85, 'number', {}), 0.85)
    assert.strictEqual(convertValue(3, 'number', { format: 'rating', max: 5 }), 3)
  })
})
