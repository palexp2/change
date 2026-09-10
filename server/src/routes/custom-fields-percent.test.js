// Contrat du type de champ « Pourcentage » :
//   • la colonne porte le NOMBRE DE POURCENTS (45 = 45 %) — passer un champ
//     nombre en pourcentage ne multiplie ni ne divise rien ;
//   • le mode d'affichage ('percent' ou 'bar') vit dans `options.display`, se
//     règle à la création et s'édite ensuite comme n'importe quel réglage ;
//   • un champ NATIF peut être affiché en pourcentage, avec le même choix
//     d'affichage (personnalisation cosmétique, aucune colonne touchée) ;
//   • un champ calculé (formule / lookup / rollup) peut se rendre en
//     pourcentage : c'est un format d'affichage, sa valeur reste un nombre.
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

describe('Champ « Pourcentage »', () => {
  after(() => closeServer(server))

  test('création : affichage « pourcentage » et 0 décimale par défaut', async () => {
    const r = await api('POST', '/api/custom-fields/projects', { name: uniqueName('Avancement'), type: 'percent' })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.equal(r.body.type, 'percent')
    assert.equal(r.body.decimals, 0, '« 45 % », pas « 45,00 % »')
    assert.deepEqual(JSON.parse(r.body.options), { display: 'percent' })
  })

  test('création en barre de progression, puis retour au pourcentage', async () => {
    const created = await api('POST', '/api/custom-fields/projects', {
      name: uniqueName('Remplissage'), type: 'percent', options: { display: 'bar' }, decimals: 1,
    })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    assert.deepEqual(JSON.parse(created.body.options), { display: 'bar' })
    assert.equal(created.body.decimals, 1)

    const edited = await api('PUT', `/api/custom-fields/${created.body.id}`, { options: { display: 'percent' } })
    assert.equal(edited.status, 200, JSON.stringify(edited.body))
    assert.deepEqual(JSON.parse(edited.body.options), { display: 'percent' })
  })

  test('un mode d’affichage inconnu retombe sur le pourcentage', async () => {
    const r = await api('POST', '/api/custom-fields/projects', {
      name: uniqueName('Taux'), type: 'percent', options: { display: 'camembert' },
    })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.deepEqual(JSON.parse(r.body.options), { display: 'percent' })
  })

  test('nombre → pourcentage : la valeur ne bouge pas', async () => {
    const created = await api('POST', '/api/custom-fields/projects', { name: uniqueName('Ratio'), type: 'number', decimals: 2 })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const col = created.body.column_name
    db.prepare(`INSERT INTO projects (id, name, ${col}) VALUES (?, ?, ?)`).run(`p-${col}`, 'rec', 45.5)

    const r = await api('PUT', `/api/custom-fields/${created.body.id}`, { type: 'percent' })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.type, 'percent')
    assert.equal(db.prepare(`SELECT [${col}] AS v FROM projects WHERE id=?`).get(`p-${col}`).v, 45.5)
  })

  test('champ natif affiché en pourcentage, en barre', async () => {
    const r = await api('PUT', '/api/custom-fields/projects/native/budget', { type: 'percent', decimals: 0 })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const withDisplay = await api('PUT', '/api/custom-fields/projects/native/budget', { options: { display: 'bar' } })
    assert.equal(withDisplay.status, 200, JSON.stringify(withDisplay.body))
    const list = await api('GET', '/api/custom-fields/projects/native')
    const row = list.body.data.find(f => f.field_id === 'budget')
    assert.equal(row.type, 'percent')
    assert.deepEqual(JSON.parse(row.options), { display: 'bar' })
  })

  test('formule rendue en pourcentage : la valeur reste un nombre', async () => {
    const r = await api('POST', '/api/custom-fields/projects', {
      name: uniqueName('Formule pct'), kind: 'formula', formula_expr: '1 + 1', result_type: 'percent',
    })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.equal(r.body.type, 'number', 'tri, filtre et totaux d’un nombre')

    const display = await api('PUT', `/api/custom-fields/${r.body.id}`, { options: { display: 'bar' } })
    assert.equal(display.status, 200, JSON.stringify(display.body))
    assert.deepEqual(JSON.parse(display.body.options), { display: 'bar' })
  })
})
