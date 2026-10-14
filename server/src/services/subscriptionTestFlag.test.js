import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectTestReason } from './subscriptionTestFlag.js'

const people = [
  { full: 'guillaume lambert', first: 'guillaume', last: 'lambert', email: 'guillaume@orisha.io' },
  { full: 'emilie carignan', first: 'emilie', last: 'carignan', email: 'marketing@orisha.io' },
]

test('repère les tests internes', () => {
  assert.ok(detectTestReason({ customerEmail: 'pap+x@orisha.io', companyName: 'Ferme' }, people))
  assert.ok(detectTestReason({ customerEmail: 'a@gmail.com', companyName: 'Test Farm' }, people))
  assert.ok(detectTestReason({ customerEmail: 'x@gmail.com', companyName: 'Guillaume Lambert' }, people))
  assert.ok(detectTestReason({ customerEmail: 'carignanemilie@gmail.com', companyName: 'Ferme X' }, people))
})

test('laisse passer les vrais clients', () => {
  assert.equal(detectTestReason({ customerEmail: 'veggies@wholesomeharvestcsa.com', companyName: 'Wholesome Harvest CSA' }, people), null)
  assert.equal(detectTestReason({ customerEmail: 'info@lambertfarm.ca', companyName: 'Ferme Lambert' }, people), null)
  assert.equal(detectTestReason({ customerEmail: 'contest@ferme.ca', companyName: 'Ferme Protestante' }, people), null)
})
