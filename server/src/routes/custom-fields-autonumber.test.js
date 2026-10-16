// Contrat du type « Numéro auto » (Autonumber d'Airtable) :
//   • champ auto-rempli, lecture seule, proposé sur toute table ;
//   • numéro croissant dans l'ordre de création, stable d'une lecture à l'autre ;
//   • valeur numérique (tri et filtres numériques).
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

describe('Champ « Numéro auto »', () => {
  after(() => closeServer(server))

  test('proposé dans les types auto de la table', async () => {
    const r = await api('GET', '/api/custom-fields/_meta/projects')
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.ok(r.body.supported_auto_types.includes('autonumber'))
  })

  test('création puis numéros croissants dans l’ordre de création', async () => {
    const r = await api('POST', '/api/custom-fields/projects', { kind: 'autonumber', name: 'Numéro auto test' })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.equal(r.body.kind, 'autonumber')
    assert.equal(r.body.type, 'number')
    assert.equal(r.body.result_type, 'number')
    const col = r.body.column_name
    db.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').run('an-1', 'A')
    db.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').run('an-0', 'B')
    const a = db.prepare(`SELECT ${col} AS n FROM projects_v WHERE id='an-1'`).get().n
    const b = db.prepare(`SELECT ${col} AS n FROM projects_v WHERE id='an-0'`).get().n
    assert.equal(typeof a, 'number')
    assert.ok(b > a, 'créé après → numéro plus grand, quel que soit l’id')
  })
})
