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
