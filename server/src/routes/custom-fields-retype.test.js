// Contrat de la route quand on change le type d'un champ existant :
//   • le verrou historique (« Le type ne peut pas être modifié après création »)
//     n'existe plus ;
//   • une valeur qui ne se convertit pas fait répondre 409 AVEC le détail —
//     rien n'est écrit tant que l'utilisateur n'a pas tranché ;
//   • `force_convert: true` passe outre et vide ces valeurs-là, sans toucher
//     celles qui se convertissent.
import test, { after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildTestApp, listen, closeServer, createTestUser, db } from '../test-helpers/testApp.js'
import customFieldsRouter from './custom-fields.js'

const app = buildTestApp({ '/api/custom-fields': customFieldsRouter })
// `custom_fields.description` vient d'une migration, pas de schema.js (le
// rebuild guardé du CHECK recrée la table sans elle sur une DB vierge).
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

// Champ texte rempli de trois valeurs dont une seule n'est pas un nombre.
async function textFieldWithValues(values) {
  const created = await api('POST', '/api/custom-fields/projects', { name: `Retype ${Math.random().toString(36).slice(2, 8)}`, kind: 'data', type: 'text' })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const col = created.body.column_name
  const ins = db.prepare(`INSERT INTO projects (id, name, ${col}) VALUES (?, ?, ?)`)
  const ids = values.map((v, i) => { const id = `p-${col}-${i}`; ins.run(id, `rec ${i}`, v); return id })
  return { id: created.body.id, col, ids }
}

const read = (col, id) => db.prepare(`SELECT [${col}] AS v FROM projects WHERE id=?`).get(id).v

describe('PUT /api/custom-fields/:id — changement de type', () => {
  after(() => closeServer(server))

  test('valeurs toutes convertibles : le type change et les valeurs suivent', async () => {
    const { id, col, ids } = await textFieldWithValues(['12', '3,5'])
    const r = await api('PUT', `/api/custom-fields/${id}`, { type: 'number' })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.type, 'number')
    assert.equal(r.body.retype.converted, 2)
    assert.equal(read(col, ids[0]), 12)
    assert.equal(read(col, ids[1]), 3.5)
  })

  test('valeur illisible : 409 avec le détail, et RIEN n’est écrit', async () => {
    const { id, col, ids } = await textFieldWithValues(['12', 'douze'])
    const r = await api('PUT', `/api/custom-fields/${id}`, { type: 'number' })
    assert.equal(r.status, 409)
    assert.equal(r.body.retype.unconvertible, 1)
    assert.equal(r.body.retype.converted, 1)
    assert.deepEqual(r.body.retype.samples, [{ value: 'douze', count: 1 }])
    assert.equal(db.prepare('SELECT type FROM custom_fields WHERE id=?').get(id).type, 'text', 'type inchangé')
    assert.equal(read(col, ids[1]), 'douze', 'valeur intacte')
  })

  test('force_convert : passe outre, vide ce qui résiste, garde le reste', async () => {
    const { id, col, ids } = await textFieldWithValues(['12', 'douze'])
    const r = await api('PUT', `/api/custom-fields/${id}`, { type: 'number', force_convert: true })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.retype.cleared, 1)
    assert.equal(read(col, ids[0]), 12)
    assert.equal(read(col, ids[1]), null)
  })

  test('texte → sélection : les choix sont dérivés des valeurs présentes', async () => {
    const { id } = await textFieldWithValues(['Installation', 'Remplacement'])
    const r = await api('PUT', `/api/custom-fields/${id}`, { type: 'single_select' })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const opts = JSON.parse(r.body.options)
    assert.deepEqual(opts.choices.map(c => c.label), ['Installation', 'Remplacement'])
  })

  test('les options de l’ancien type ne survivent pas au changement', async () => {
    const { id } = await textFieldWithValues(['Installation'])
    await api('PUT', `/api/custom-fields/${id}`, { type: 'single_select' })
    const r = await api('PUT', `/api/custom-fields/${id}`, { type: 'text' })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.options, null, 'plus de choix sous un champ texte')
  })
})
