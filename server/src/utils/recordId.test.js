import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newRecordId, isCompactRecordId } from './recordId.js'
import { newId } from './ids.js'

test('newRecordId — 17 caractères, préfixe bor, alphanumérique', () => {
  const id = newRecordId()
  assert.equal(id.length, 17)
  assert.match(id, /^bor[0-9A-Za-z]{14}$/)
})

test('newRecordId — jamais confondu avec un record ID Airtable', () => {
  // 'rec' + 14 alphanumériques est la forme d'Airtable : l'ERP s'en sert pour
  // savoir si une clé désigne l'`airtable_id` ou l'`id` ERP.
  for (let i = 0; i < 200; i++) assert.doesNotMatch(newRecordId(), /^rec[A-Za-z0-9]{14}$/)
})

test('newRecordId — pas de collision sur 20 000 tirages', () => {
  const seen = new Set()
  for (let i = 0; i < 20000; i++) seen.add(newRecordId())
  assert.equal(seen.size, 20000)
})

test('newRecordId — préfixe personnalisable', () => {
  assert.match(newRecordId('opt_'), /^opt_[0-9A-Za-z]{14}$/)
})

test('isCompactRecordId', () => {
  assert.ok(isCompactRecordId(newRecordId()))
  assert.ok(!isCompactRecordId('recB4Fehk9jYd4s4B'))
  assert.ok(!isCompactRecordId('550e8400-e29b-41d4-a716-446655440000'))
  assert.ok(!isCompactRecordId(null))
  assert.ok(!isCompactRecordId(''))
})

test('newId — ids typés compacts, préfixe conservé', () => {
  assert.match(newId('auto'), /^aut_[0-9A-Za-z]{14}$/)
  assert.match(newId('version'), /^ver_[0-9A-Za-z]{14}$/)
  assert.throws(() => newId('inconnu'))
})
