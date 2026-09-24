import { test } from 'node:test'
import assert from 'node:assert'
import { extractCardLast4 } from './paymentCards.js'

test('reconnaît les masques de carte', () => {
  assert.deepStrictEqual(extractCardLast4('VISA ****6015'), ['6015'])
  assert.deepStrictEqual(extractCardLast4('XXXX-XXXX-XXXX-5004'), ['5004'])
  assert.deepStrictEqual(extractCardLast4('Mastercard se terminant par 4823'), ['4823'])
  assert.deepStrictEqual(extractCardLast4('card ending in 1427'), ['1427'])
})

test('ignore les nombres qui ne sont pas des cartes', () => {
  assert.deepStrictEqual(extractCardLast4('Facture 132580242'), [])
  assert.deepStrictEqual(extractCardLast4('Commande 4815-2026'), [])
  assert.deepStrictEqual(extractCardLast4(null), [])
})
