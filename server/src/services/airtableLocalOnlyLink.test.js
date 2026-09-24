import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keepLocalOnlyLink } from './airtableAutoSync.js'

test('lien vers un référent né dans Boréal : un champ Airtable vide ne l’efface pas', () => {
  const local = JSON.stringify(['59be735d-356d-4f70-a049-209ccaaf1023'])
  assert.equal(keepLocalOnlyLink(local, null), local)
  assert.equal(keepLocalOnlyLink(local, ''), local)
  // Une vraie valeur Airtable reste prioritaire.
  assert.equal(keepLocalOnlyLink(local, '["recAbcdefghijklmn"]'), '["recAbcdefghijklmn"]')
  // Un lien Airtable vidé dans Airtable se vide aussi dans Boréal.
  assert.equal(keepLocalOnlyLink('["recAbcdefghijklmn"]', null), null)
})
