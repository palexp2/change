import test from 'node:test'
import assert from 'node:assert/strict'
import { changedSinceFor, entitiesFromCdc } from './qbChangePoll.js'

const NOW = Date.parse('2026-09-19T18:00:00.000Z')

test('fenêtre : recouvrement de 2 min sur le curseur précédent', () => {
  const since = changedSinceFor(NOW, '2026-09-19T17:59:30.000Z')
  assert.equal(since, '2026-09-19T17:57:30Z')
})

test('sans curseur : on repart de la demi-heure écoulée', () => {
  assert.equal(changedSinceFor(NOW, null), '2026-09-19T17:30:00Z')
})

test('curseur trop vieux ou illisible : ramené dans la fenêtre acceptée', () => {
  assert.equal(changedSinceFor(NOW, '2020-01-01T00:00:00.000Z'), '2026-09-12T18:00:00Z')
  assert.equal(changedSinceFor(NOW, 'n’importe quoi'), '2026-09-19T17:30:00Z')
})

test('lecture de la réponse : modifiés, supprimés, et rien d’autre', () => {
  const data = { CDCResponse: [{ QueryResponse: [
    { Purchase: [
      { Id: '101', MetaData: { LastUpdatedTime: '2026-09-19T17:58:00-07:00' } },
      { Id: '102', status: 'Deleted' },
    ] },
    { Deposit: [{ Id: '7', MetaData: { LastUpdatedTime: '2026-09-19T17:59:00-07:00' } }] },
    { startPosition: 1, maxResults: 3 },
  ] }] }
  const out = entitiesFromCdc(data, 'realm-1')
  assert.deepEqual(out.map((e) => [e.name, e.id, e.operation]), [
    ['Purchase', '101', 'Update'],
    ['Purchase', '102', 'Delete'],
    ['Deposit', '7', 'Update'],
  ])
  assert.equal(out[0].realmId, 'realm-1')
  assert.equal(out[0].lastUpdated, '2026-09-19T17:58:00-07:00')
})

test('réponse vide : rien à traiter', () => {
  assert.deepEqual(entitiesFromCdc({}, 'r'), [])
  assert.deepEqual(entitiesFromCdc({ CDCResponse: [{ QueryResponse: [] }] }, 'r'), [])
})
