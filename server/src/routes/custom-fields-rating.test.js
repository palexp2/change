// Contrat du type « Évaluation » : le symbole (étoile, cœur…) vit dans
// `options.icon`, se règle à la création, s'édite ensuite, et vaut aussi pour
// un champ natif affiché en évaluation. Symbole inconnu → étoile.
import test, { after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildTestApp, listen, closeServer, createTestUser, db } from '../test-helpers/testApp.js'
import customFieldsRouter from './custom-fields.js'

const app = buildTestApp({ '/api/custom-fields': customFieldsRouter })
;(await import('../db/migrations/014-custom-field-description.js')).up(db)
const { base, server } = await listen(app)
const { token } = createTestUser()

async function api(method, path, body) {
  const headers = { Authorization: `Bearer ${token}` }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let parsed; try { parsed = text ? JSON.parse(text) : null } catch { parsed = text }
  return { status: res.status, body: parsed }
}

const uniqueName = prefix => `${prefix} ${Math.random().toString(36).slice(2, 8)}`

describe('Champ « Évaluation » : symbole', () => {
  after(() => closeServer(server))

  test('création : étoile par défaut, symbole inconnu → étoile', async () => {
    const r = await api('POST', '/api/custom-fields/projects', { name: uniqueName('Note'), type: 'rating' })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.deepEqual(JSON.parse(r.body.options), { icon: 'star' })
    const odd = await api('POST', '/api/custom-fields/projects', { name: uniqueName('Note'), type: 'rating', options: { icon: 'licorne' } })
    assert.deepEqual(JSON.parse(odd.body.options), { icon: 'star' })
  })

  test('création en cœurs, puis passage en pouces', async () => {
    const created = await api('POST', '/api/custom-fields/projects', { name: uniqueName('Coup de cœur'), type: 'rating', options: { icon: 'heart' } })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    assert.deepEqual(JSON.parse(created.body.options), { icon: 'heart' })
    const edited = await api('PUT', `/api/custom-fields/${created.body.id}`, { options: { icon: 'thumbs_up' } })
    assert.equal(edited.status, 200, JSON.stringify(edited.body))
    assert.deepEqual(JSON.parse(edited.body.options), { icon: 'thumbs_up' })
  })

  test('champ natif affiché en évaluation, en drapeaux', async () => {
    const r = await api('PUT', '/api/custom-fields/projects/native/budget', { type: 'rating' })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const withIcon = await api('PUT', '/api/custom-fields/projects/native/budget', { options: { icon: 'flag' } })
    assert.equal(withIcon.status, 200, JSON.stringify(withIcon.body))
    const row = db.prepare(`SELECT options FROM custom_fields WHERE erp_table='projects' AND kind='native' AND column_name='budget'`).get()
    assert.equal(JSON.parse(row.options).icon, 'flag')
  })
})
