import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lookupCancelUrl, CANCEL_URL_DIRECTORY } from './subscriptionCancelUrls.js'

test('répertoire : résolution directe et variantes de nom', () => {
  assert.equal(lookupCancelUrl('Airtable'), 'https://airtable.com/account/billing')
  assert.equal(lookupCancelUrl('Linode Akamai'), 'https://cloud.linode.com/account/billing')
  // Suffixe de devise QuickBooks et ponctuation ignorés.
  assert.equal(lookupCancelUrl('Telnyx USD'), CANCEL_URL_DIRECTORY.telnyx)
  assert.equal(lookupCancelUrl('MONOLOGUE.TO'), CANCEL_URL_DIRECTORY.monologueto)
  assert.equal(lookupCancelUrl('Bell Mobilité'), CANCEL_URL_DIRECTORY.bellmobilite)
})

test('répertoire : fournisseur inconnu → pas de lien inventé', () => {
  assert.equal(lookupCancelUrl('Fournisseur Inexistant XYZ'), null)
  assert.equal(lookupCancelUrl(''), null)
  assert.equal(lookupCancelUrl(null), null)
})

test('répertoire : toutes les entrées sont des URLs https', () => {
  for (const [key, url] of Object.entries(CANCEL_URL_DIRECTORY)) {
    assert.match(url, /^https:\/\/\S+$/, `${key} doit pointer une URL https`)
  }
})
