// Routes réelles sur la base temporaire du harnais serveur.
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')

test('API — épinglage persistant, tri, pagination et authentification', async () => {
  const { buildTestApp, listen, closeServer, createTestUser, db, apiFetch } = await import('../../server/src/test-helpers/testApp.js')
  const { default: router } = await import('../../server/src/routes/interactions.js')
  const { base, server } = await listen(buildTestApp({ '/api/interactions': router }))
  after(() => closeServer(server))
  // Le harnais minimal ne pose pas les colonnes de corbeille des tables CRM.
  for (const table of ['contacts', 'interactions']) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === 'deleted_at')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN deleted_at TEXT`)
    }
  }
  const { token } = createTestUser()
  const contactId = randomUUID()
  db.prepare('INSERT INTO contacts (id, first_name, last_name) VALUES (?, ?, ?)').run(contactId, 'Pin', 'Test')
  const request = (method, path, body, auth = token) => apiFetch(base, auth, method, '/api/interactions' + path, body)
  const ids = []
  for (const [i, type] of ['call', 'email', 'sms', 'meeting', 'note'].entries()) {
    const result = await request('POST', '', { contact_id: contactId, type, notes: `Note ${type}`, timestamp: `2026-09-${20 - i}T12:00:00Z` })
    assert.equal(result.status, 201, JSON.stringify(result.body))
    ids.push(result.body.id)
  }
  for (const id of ids) {
    assert.equal((await request('PATCH', `/${id}/pin`, { pinned: true }, null)).status, 401)
    const pinned = await request('PATCH', `/${id}/pin`, { pinned: true })
    assert.equal(pinned.status, 200)
    assert.equal(pinned.body.pinned, 1)
    assert.ok(pinned.body.pinned_at)
    assert.equal((await request('GET', `/${id}`)).body.pinned, 1)
    const list = await request('GET', `?contact_id=${contactId}&limit=1&include=heavy`)
    assert.equal(list.body.interactions[0].id, id)
    assert.ok(list.body.interactions[0].meeting_notes)
    assert.equal(list.body.total, 5)
    assert.equal((await request('PATCH', `/${id}/pin`, { pinned: false })).body.pinned_at, null)
    assert.equal((await request('GET', `/${id}`)).body.pinned, 0)
  }
  const list = await request('GET', `?contact_id=${contactId}&limit=2&offset=2`)
  assert.deepEqual(list.body.interactions.map(i => i.id), ids.slice(2, 4))
  assert.equal((await request('PATCH', '/missing/pin', { pinned: true })).status, 404)
  assert.equal((await request('DELETE', `/${ids[0]}`)).status, 200)
  assert.equal((await request('PATCH', `/${ids[0]}/pin`, { pinned: true })).status, 404)
})
