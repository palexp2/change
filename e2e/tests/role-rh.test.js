const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')

const ERP = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

async function api(token, method, path, body) {
  const res = await fetch(`${ERP}/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  let json = null
  try { json = await res.json() } catch {}
  return { status: res.status, body: json }
}

async function login(email, password) {
  const r = await api(null, 'POST', '/auth/login', { email, password })
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${JSON.stringify(r.body)}`)
  return r.body.token
}

describe('Role RH — accès et restrictions', () => {
  const ts = Date.now()
  const opsEmail = `e2e-ops-${ts}@example.com`
  const rhEmail = `e2e-rh-${ts}@example.com`
  const password = 'testpassword123'

  let adminToken, opsUser, rhUser, opsToken, rhToken

  before(async () => {
    adminToken = await login(EMAIL, PASS)
    const opsRes = await api(adminToken, 'POST', '/admin/users', { email: opsEmail, name: 'E2E Ops', password, role: 'ops' })
    if (opsRes.status !== 201) throw new Error(`create ops failed: ${opsRes.status} ${JSON.stringify(opsRes.body)}`)
    opsUser = opsRes.body

    const rhRes = await api(adminToken, 'POST', '/admin/users', { email: rhEmail, name: 'E2E RH', password, role: 'rh' })
    if (rhRes.status !== 201) throw new Error(`create rh failed: ${rhRes.status} ${JSON.stringify(rhRes.body)}`)
    rhUser = rhRes.body

    opsToken = await login(opsEmail, password)
    rhToken = await login(rhEmail, password)
  })

  after(async () => {
    if (opsUser?.id) await api(adminToken, 'DELETE', `/admin/users/${opsUser.id}`)
    if (rhUser?.id) await api(adminToken, 'DELETE', `/admin/users/${rhUser.id}`)
  })

  test('Le rôle rh est accepté par /admin/users', () => {
    assert.equal(rhUser.role, 'rh')
  })

  test('ops → 403 sur GET /employees', async () => {
    const r = await api(opsToken, 'GET', '/employees')
    assert.equal(r.status, 403)
  })

  test('rh → 200 sur GET /employees', async () => {
    const r = await api(rhToken, 'GET', '/employees')
    assert.equal(r.status, 200)
    assert.ok(Array.isArray(r.body.data))
  })

  test('ops → 403 sur POST /employees', async () => {
    const r = await api(opsToken, 'POST', '/employees', { first_name: 'X', last_name: 'Y' })
    assert.equal(r.status, 403)
  })

  test('ops → 200 sur GET /hour-bank mais data vide (pas lié à un employé)', async () => {
    const r = await api(opsToken, 'GET', '/hour-bank')
    assert.equal(r.status, 200)
    assert.equal(r.body.data.length, 0, 'ops sans employee_id ne doit voir aucune ligne')
  })

  test('rh → GET /hour-bank retourne tous les employés', async () => {
    const r = await api(rhToken, 'GET', '/hour-bank')
    assert.equal(r.status, 200)
    assert.ok(r.body.data.length > 0, 'rh doit voir au moins un employé')
  })

  test('ops → 403 sur POST /hour-bank', async () => {
    const r = await api(opsToken, 'POST', '/hour-bank', { employee_id: 'fake', date: '2026-05-12', hours: 1 })
    assert.equal(r.status, 403)
  })

  test('ops → 200 sur GET /paies mais liste filtrée (vide sans employee lié)', async () => {
    const r = await api(opsToken, 'GET', '/paies')
    assert.equal(r.status, 200)
    assert.equal(r.body.total, 0, 'ops sans employee_id ne doit voir aucune paie')
  })

  test('rh → 200 sur GET /paies', async () => {
    const r = await api(rhToken, 'GET', '/paies')
    assert.equal(r.status, 200)
  })

  test('ops → 403 sur POST /paies', async () => {
    const r = await api(opsToken, 'POST', '/paies', { period_end: '2026-05-12' })
    assert.equal(r.status, 403)
  })

  test('ops → 403 sur GET /timesheets?user_id=other', async () => {
    const r = await api(opsToken, 'GET', `/timesheets?user_id=${encodeURIComponent(rhUser.id)}`)
    assert.equal(r.status, 403)
  })

  test('rh → 200 sur GET /timesheets?user_id=other', async () => {
    const r = await api(rhToken, 'GET', `/timesheets?user_id=${encodeURIComponent(opsUser.id)}`)
    assert.equal(r.status, 200)
  })
})
