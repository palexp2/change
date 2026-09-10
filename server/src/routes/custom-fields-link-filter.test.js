// Contrat du FILTRE d'un champ lien : les conditions posées dans la fiche du
// champ restreignent les candidats proposés au moment de lier. Elles vivent
// dans `options.link_filter`, sont validées contre les colonnes réelles de la
// table visée, et la liste des champs les republie (`record_link_filter`) pour
// que le picker du client les applique.
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

describe('Filtre d\'un champ lien', () => {
  after(() => closeServer(server))

  test('créé avec un filtre : republié avec le champ', async () => {
    const r = await api('POST', '/api/custom-fields/projects', {
      name: nom(), type: 'text', link_display_target: 'companies',
      link_filter: [{ column: 'name', op: 'contains', value: 'Ferme' }],
    })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    const f = await listed(r.body.id)
    assert.deepEqual(f.record_link_filter, [{ column: 'name', op: 'contains', value: 'Ferme' }])
  })

  test('posé puis retiré sur un champ lien existant', async () => {
    const created = await api('POST', '/api/custom-fields/projects', { name: nom(), type: 'text', link_display_target: 'companies' })
    assert.deepEqual((await listed(created.body.id)).record_link_filter, [])

    const put = await api('PUT', `/api/custom-fields/${created.body.id}`, {
      link_filter: [{ column: 'city', op: 'is', value: 'Québec' }],
    })
    assert.equal(put.status, 200, JSON.stringify(put.body))
    const f = await listed(created.body.id)
    assert.deepEqual(f.record_link_filter, [{ column: 'city', op: 'is', value: 'Québec' }])
    // La table visée n'a pas bougé au passage.
    assert.equal(f.record_link_target, 'companies')

    await api('PUT', `/api/custom-fields/${created.body.id}`, { link_filter: [] })
    const cleared = await listed(created.body.id)
    assert.deepEqual(cleared.record_link_filter, [])
    assert.equal(cleared.record_link_target, 'companies')
  })

  test('opérateur sans valeur : accepté et stocké sans valeur', async () => {
    const created = await api('POST', '/api/custom-fields/projects', { name: nom(), type: 'text', link_display_target: 'companies' })
    const put = await api('PUT', `/api/custom-fields/${created.body.id}`, {
      link_filter: [{ column: 'city', op: 'not_empty' }],
    })
    assert.equal(put.status, 200, JSON.stringify(put.body))
    assert.deepEqual((await listed(created.body.id)).record_link_filter, [{ column: 'city', op: 'not_empty', value: '' }])
  })

  test('« est l\'un des » : la liste de choix fait l\'aller-retour', async () => {
    const created = await api('POST', '/api/custom-fields/projects', { name: nom(), type: 'text', link_display_target: 'companies' })
    const put = await api('PUT', `/api/custom-fields/${created.body.id}`, {
      link_filter: [{ column: 'city', op: 'is_any_of', value: ['Québec', 'Lévis'] }],
    })
    assert.equal(put.status, 200, JSON.stringify(put.body))
    assert.deepEqual((await listed(created.body.id)).record_link_filter,
      [{ column: 'city', op: 'is_any_of', value: ['Québec', 'Lévis'] }])
  })

  test('« n\'est aucun des » sans aucun choix : refusé', async () => {
    const created = await api('POST', '/api/custom-fields/projects', { name: nom(), type: 'text', link_display_target: 'companies' })
    const r = await api('PUT', `/api/custom-fields/${created.body.id}`, {
      link_filter: [{ column: 'city', op: 'is_none_of', value: [] }],
    })
    assert.equal(r.status, 400)
  })

  test('colonne inconnue de la table visée : refusé', async () => {
    const created = await api('POST', '/api/custom-fields/projects', { name: nom(), type: 'text', link_display_target: 'companies' })
    const r = await api('PUT', `/api/custom-fields/${created.body.id}`, {
      link_filter: [{ column: 'colonne_qui_nexiste_pas', op: 'is', value: 'x' }],
    })
    assert.equal(r.status, 400)
    assert.deepEqual((await listed(created.body.id)).record_link_filter, [])
  })

  test('opérateur inconnu : refusé', async () => {
    const created = await api('POST', '/api/custom-fields/projects', { name: nom(), type: 'text', link_display_target: 'companies' })
    const r = await api('PUT', `/api/custom-fields/${created.body.id}`, {
      link_filter: [{ column: 'name', op: 'ressemble_a', value: 'x' }],
    })
    assert.equal(r.status, 400)
  })

  test('champ qui n\'est pas un lien : refusé', async () => {
    const created = await api('POST', '/api/custom-fields/projects', { name: nom(), type: 'text' })
    const r = await api('PUT', `/api/custom-fields/${created.body.id}`, {
      link_filter: [{ column: 'name', op: 'is', value: 'x' }],
    })
    assert.equal(r.status, 400)
  })

  test('table visée et filtre posés dans le même PUT', async () => {
    const created = await api('POST', '/api/custom-fields/projects', { name: nom(), type: 'text' })
    const put = await api('PUT', `/api/custom-fields/${created.body.id}`, {
      link_display_target: 'products',
      link_filter: [{ column: 'sku', op: 'not_empty' }],
    })
    assert.equal(put.status, 200, JSON.stringify(put.body))
    const f = await listed(created.body.id)
    assert.equal(f.record_link_target, 'products')
    assert.deepEqual(f.record_link_filter, [{ column: 'sku', op: 'not_empty', value: '' }])
  })
})
