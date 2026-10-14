import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normHsId, contactEmails, hsContactToErp } from './hubspotContactsSync.js'

test('normHsId retire le « .0 » des ids importés d\'Airtable', () => {
  assert.equal(normHsId('1038251.0'), '1038251')
  assert.equal(normHsId(101), '101')
  assert.equal(normHsId(''), null)
  assert.equal(normHsId(null), null)
})

test('contactEmails : principal puis secondaires, sans doublon', () => {
  assert.deepEqual(
    contactEmails({ email: 'A@x.com', hs_additional_emails: 'b@x.com;a@x.com' }),
    ['a@x.com', 'b@x.com'],
  )
  assert.deepEqual(contactEmails({}), [])
})

test('hsContactToErp : nom obligatoire, entreprise non touchée si inconnue', () => {
  const v = hsContactToErp({ firstname: 'Marjorie', lastname: null, email: null, phone: '' }, undefined)
  assert.deepEqual(v, { first_name: 'Marjorie', last_name: 'Marjorie', email: null, phone: null })
  assert.equal(hsContactToErp({ firstname: 'A', lastname: 'B' }, null).company_id, null)
})
