// parseDuplicateNameId : extrait l'Id du conflit d'une erreur QB « Nom en double »
// (code 6240). QB impose des DisplayName uniques entre Fournisseurs/Clients/Employés ;
// l'Id de l'entité en conflit est donné dans le Detail du Fault.

import test from 'node:test'
import assert from 'node:assert/strict'

const { parseDuplicateNameId } = await import('./quickbooks.js')

test('extrait l\'Id d\'un Fault 6240 réel', () => {
  const msg = 'QB API POST /vendor 400: {"Fault":{"Error":[{"Message":"Nom en double","Detail":"Ce nom existe déjà. : Id=425","code":"6240"}],"type":"ValidationFault"}}'
  assert.equal(parseDuplicateNameId(msg), '425')
})

test('reconnaît la variante anglaise « Duplicate Name »', () => {
  const msg = 'QB API POST /vendor 400: {"Fault":{"Error":[{"Message":"Duplicate Name Exists Error","Detail":"The name supplied already exists. : Id=1067","code":"6240"}]}}'
  assert.equal(parseDuplicateNameId(msg), '1067')
})

test('null si ce n\'est pas un conflit de nom', () => {
  assert.equal(parseDuplicateNameId('QB API POST /vendor 400: {"code":"610"}'), null)
  assert.equal(parseDuplicateNameId('autre erreur réseau'), null)
})

test('null si 6240 mais sans Id exploitable', () => {
  assert.equal(parseDuplicateNameId('{"Message":"Nom en double","code":"6240"}'), null)
})

test('robuste aux entrées vides / nulles', () => {
  assert.equal(parseDuplicateNameId(''), null)
  assert.equal(parseDuplicateNameId(null), null)
  assert.equal(parseDuplicateNameId(undefined), null)
})

// buildQbApiError (connectors/quickbooks.js) traduit le Fault QB en message FR concis
// avant qu'il n'atteigne createVendorHandlingDuplicate — le texte ne contient alors ni
// "Nom en double" ni "Duplicate Name" ni "code":"6240" littéralement. C'est err.qbCode
// (posé par buildQbApiError) qui doit faire foi, avec l'Id toujours extrait du message.
test('détecte le conflit via qbCode même quand le message est déjà traduit en FR', () => {
  const msg = 'QuickBooks : ce nom existe déjà dans QuickBooks (les noms sont uniques entre Clients, Fournisseurs et Employés). Détail : Ce nom existe déjà. : Id=1122'
  assert.equal(parseDuplicateNameId(msg, '6240'), '1122')
})

test('qbCode 6240 sans Id exploitable reste null', () => {
  assert.equal(parseDuplicateNameId('QuickBooks : ce nom existe déjà dans QuickBooks.', '6240'), null)
})

test('qbCode absent retombe sur la détection par regex du message', () => {
  assert.equal(parseDuplicateNameId('autre erreur', '610'), null)
})
