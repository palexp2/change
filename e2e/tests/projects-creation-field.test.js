// Vérifie que le champ `creation` (originellement importé d'Airtable) est
// désormais rempli automatiquement pour les projets créés nativement dans l'ERP.
// Cf. routes/projects.js POST + backfill schema.js.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS || 'saluerlessoviets'

async function login() {
  const r = await fetch(`${URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASS }),
  })
  if (!r.ok) throw new Error(`Login failed: ${r.status}`)
  const { token } = await r.json()
  return token
}

describe('Projects — champ canonique `creation`', () => {
  let token, createdId

  before(async () => { token = await login() })

  after(async () => {
    if (createdId) {
      await fetch(`${URL}/api/projects/${createdId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
    }
  })

  test('POST /api/projects remplit `creation` à la création', async () => {
    const beforeIso = new Date().toISOString()
    const r = await fetch(`${URL}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'E2E creation field test' }),
    })
    assert.equal(r.status, 201)
    const proj = await r.json()
    createdId = proj.id

    assert.ok(proj.creation, '`creation` doit être rempli à la création native')
    assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(proj.creation), 'doit être ISO 8601')
    assert.ok(proj.creation.endsWith('Z'), 'doit être UTC (suffix Z)')
    assert.ok(proj.creation >= beforeIso, '`creation` doit être >= moment du test')
  })

  test('aucun projet existant n\'a `creation IS NULL` (backfill)', async () => {
    const r = await fetch(`${URL}/api/projects?limit=all`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(r.status, 200)
    const { data } = await r.json()
    const missing = data.filter(p => !p.creation)
    assert.equal(missing.length, 0, `${missing.length} projet(s) sans creation: ${missing.slice(0, 3).map(p => p.name).join(', ')}`)
  })
})
