import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { expectedSignature, signatureMatches, eventKey, SUBSCRIBED_ENTITIES } from './quickbooks-webhook.js'

// Corps et jeton connus : la signature attendue est reproductible à la main.
const BODY = Buffer.from(JSON.stringify({
  eventNotifications: [{
    realmId: '9130350000000000',
    dataChangeEvent: {
      entities: [{ name: 'Purchase', id: '12345', operation: 'Create', lastUpdated: '2026-09-15T14:02:11-0700' }],
    },
  }],
}), 'utf8')
const TOKEN = 'jeton-de-verification-de-test'

test('la signature est le HMAC-SHA256 du corps brut, en base64', () => {
  const attendu = createHmac('sha256', TOKEN).update(BODY).digest('base64')
  assert.equal(expectedSignature(BODY, TOKEN), attendu)
  assert.ok(signatureMatches(BODY, TOKEN, attendu))
})

test('une signature fausse est refusée', () => {
  const bonne = expectedSignature(BODY, TOKEN)
  // Même longueur, un caractère changé : timingSafeEqual doit dire non.
  const fausse = (bonne[0] === 'A' ? 'B' : 'A') + bonne.slice(1)
  assert.equal(signatureMatches(BODY, TOKEN, fausse), false)
  // Signée avec un autre jeton (cas du jeton régénéré chez Intuit).
  assert.equal(signatureMatches(BODY, TOKEN, expectedSignature(BODY, 'autre-jeton')), false)
  // Corps modifié après signature.
  assert.equal(signatureMatches(Buffer.concat([BODY, Buffer.from(' ')]), TOKEN, bonne), false)
})

test('sans en-tête ou sans jeton, rien ne passe', () => {
  assert.equal(signatureMatches(BODY, TOKEN, undefined), false)
  assert.equal(signatureMatches(BODY, null, expectedSignature(BODY, TOKEN)), false)
})

test("la clé d'idempotence distingue les opérations et les versions", () => {
  const base = { realmId: 'r1', name: 'Purchase', id: '12345', operation: 'Create', lastUpdated: 'T1' }
  assert.equal(eventKey(base), eventKey({ ...base }))
  assert.notEqual(eventKey(base), eventKey({ ...base, operation: 'Update' }))
  assert.notEqual(eventKey(base), eventKey({ ...base, lastUpdated: 'T2' }))
  assert.notEqual(eventKey(base), eventKey({ ...base, realmId: 'r2' }))
})

test('les entités à cocher chez Intuit sont bien les neuf attendues', () => {
  assert.deepEqual([...SUBSCRIBED_ENTITIES].sort(), [
    'Bill', 'BillPayment', 'Deposit', 'JournalEntry', 'Payment',
    'Purchase', 'RefundReceipt', 'SalesReceipt', 'Transfer',
  ])
})
