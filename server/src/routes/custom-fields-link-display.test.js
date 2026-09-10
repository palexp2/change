// Contrat du type « Lien » d'un champ de donnée : la colonne reste du texte
// (elle porte l'identifiant d'une fiche), la table visée vit dans `options`, et
// la liste des champs annonce le champ comme une référence (`record_link`) pour
// que le client l'affiche en pastille cliquable.
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

const nom = () => `Lien ${Math.random().toString(36).slice(2, 8)}`
const listed = async (id) => (await api('GET', '/api/custom-fields/projects')).body.data.find(f => f.id === id)

describe('Champ de donnée de type « Lien »', () => {
  after(() => closeServer(server))

  test('créé avec une table cible : texte en base, référence à la lecture', async () => {
    const r = await api('POST', '/api/custom-fields/projects', { name: nom(), type: 'text', link_display_target: 'companies' })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.equal(r.body.type, 'text')
    const f = await listed(r.body.id)
    assert.equal(f.record_link, true)
    assert.equal(f.record_link_target, 'companies')
    assert.equal(f.record_link_identity, 'erp')
  })

  test('posé puis retiré sur un champ texte existant', async () => {
    const created = await api('POST', '/api/custom-fields/projects', { name: nom(), type: 'text' })
    assert.equal((await listed(created.body.id)).record_link, false)

    const put = await api('PUT', `/api/custom-fields/${created.body.id}`, { link_display_target: 'contacts' })
    assert.equal(put.status, 200, JSON.stringify(put.body))
    assert.equal((await listed(created.body.id)).record_link_target, 'contacts')

    await api('PUT', `/api/custom-fields/${created.body.id}`, { link_display_target: null })
    const f = await listed(created.body.id)
    assert.equal(f.record_link, false)
    assert.equal(f.record_link_target, null)
  })

  test('table sans fiche à ouvrir : refusé', async () => {
    const created = await api('POST', '/api/custom-fields/projects', { name: nom(), type: 'text' })
    const r = await api('PUT', `/api/custom-fields/${created.body.id}`, { link_display_target: 'users' })
    assert.equal(r.status, 400)
    assert.equal((await listed(created.body.id)).record_link, false)
  })

  test('changer le type du champ efface la table visée', async () => {
    const created = await api('POST', '/api/custom-fields/projects', { name: nom(), type: 'text', link_display_target: 'orders' })
    const r = await api('PUT', `/api/custom-fields/${created.body.id}`, { type: 'number' })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const f = await listed(created.body.id)
    assert.equal(f.record_link, false)
  })
})
