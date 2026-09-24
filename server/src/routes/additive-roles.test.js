import '../test-helpers/testEnv.js'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { initTestDb, db, createTestUser, buildTestApp, listen, closeServer, apiFetch } from '../test-helpers/testApp.js'
import { rolesOf, hasRole, validateRoles } from '../../../shared/roles.mjs'
import { verifySession } from '../services/sessionSecurity.js'
import { filterCachedSpecs, canReceiveChannel } from '../services/dataAccess.js'

initTestDb()
const { default: employees } = await import('./employees.js')
const { default: paies } = await import('./paies.js')
const { default: timesheets } = await import('./timesheets.js')
const { default: vacations } = await import('./vacations.js')
const { default: records } = await import('./records.js')
const { default: admin } = await import('./admin.js')
const { default: auth } = await import('./auth.js')
const { default: activityCodes } = await import('./activity-codes.js')
const { base, server } = await listen(buildTestApp({
  '/employees': employees, '/paies': paies, '/timesheets': timesheets,
  '/vacations': vacations, '/records': records, '/admin': admin, '/auth': auth, '/activity-codes': activityCodes,
}))
after(() => closeServer(server))
const actors = []
for (const roles of [[], ['admin'], ['rh'], ['admin', 'rh']]) {
  const actor = createTestUser({ role: 'user' })
  const employee = `employee-${actor.id}`
  db.prepare('INSERT INTO employees (id, first_name, last_name) VALUES (?, ?, ?)').run(employee, 'Test', actor.id)
  db.prepare('UPDATE users SET roles=?, employee_id=? WHERE id=?').run(JSON.stringify(['user', ...roles]), employee, actor.id)
  actors.push({ ...actor, roles, employee })
}
const [basic, adminOnly, hr, both] = actors
const payroll = 'roles-payroll'
db.prepare('INSERT INTO paies (id, number, period_end, total_with_charges_and_reimb) VALUES (?, 1, ?, 99999)').run(payroll, '2026-09-19')
for (const a of actors) {
  db.prepare('INSERT INTO paie_items (id, paie_id, employee_id, hourly_rate, regular_hours) VALUES (?, ?, ?, 25, 35)').run(`item-${a.id}`, payroll, a.employee)
}
const call = (a, method, path, body) => apiFetch(base, a.token, method, path, body)

test('base implicit, grants independent, malformed grants rejected', () => {
  assert.deepEqual(validateRoles([]), ['user'])
  assert.deepEqual(rolesOf({ roles: ['rh', 'admin', 'admin'] }), ['user', 'admin', 'rh'])
  assert.equal(hasRole({ roles: ['admin'] }, 'rh'), false)
  assert.equal(hasRole({ roles: ['rh'] }, 'admin'), false)
  assert.throws(() => validateRoles('admin'))
  assert.throws(() => validateRoles(['ops']))
})

test('four combinations: own employee/payroll/time always accessible; others require RH', async () => {
  for (const actor of actors) {
    const allHR = actor.roles.includes('rh')
    const own = await call(actor, 'GET', `/employees/${actor.employee}`)
    assert.equal(own.status, 200)
    const other = actors.find(a => a.id !== actor.id)
    assert.equal((await call(actor, 'GET', `/employees/${other.employee}`)).status, allHR ? 200 : 403)
    const list = await call(actor, 'GET', '/employees')
    assert.equal(list.status, 200)
    if (!allHR) assert.deepEqual(list.body.data.map(e => e.id), [actor.employee])
    assert.equal((await call(actor, 'PATCH', `/employees/${actor.employee}`, { first_name: 'Test' })).status, allHR ? 200 : 403)
    assert.equal((await call(actor, 'GET', '/timesheets')).status, 200)
    assert.equal((await call(actor, 'GET', `/timesheets?user_id=${other.id}`)).status, allHR ? 200 : 403)
    const payrollResponse = await call(actor, 'GET', `/paies/${payroll}`)
    assert.equal(payrollResponse.status, 200, JSON.stringify(payrollResponse.body))
    assert.equal(payrollResponse.body.items.length, allHR ? 4 : 1)
    if (!allHR) {
      assert.equal(payrollResponse.body.items[0].employee_id, actor.employee)
      assert.equal('total_with_charges_and_reimb' in payrollResponse.body, false)
      assert.equal((await call(actor, 'GET', `/vacations/balance?employee_id=${other.employee}`)).status, 403)
      assert.equal((await call(actor, 'PATCH', `/records/employees/${other.employee}`, { first_name: 'Forbidden' })).status, 403)
      const itemList = await call(actor, 'GET', '/paies/items/list')
      assert.deepEqual(itemList.body.data.map(i => i.employee_id), [actor.employee])
    }
    assert.equal((await call(actor, 'GET', '/admin/users')).status, actor.roles.includes('admin') ? 200 : 403)
    const me = await call(actor, 'GET', '/auth/me')
    assert.deepEqual(me.body.roles, ['user', ...actor.roles])
  }
})

test('no employee link grants no employee/payroll access', async () => {
  const unlinked = createTestUser({ role: 'user' })
  assert.deepEqual((await call(unlinked, 'GET', '/employees')).body.data, [])
  assert.equal((await call(unlinked, 'GET', `/employees/${basic.employee}`)).status, 403)
  assert.equal((await call(unlinked, 'GET', `/paies/${payroll}`)).status, 403)
  assert.deepEqual((await call(unlinked, 'GET', '/paies')).body.data, [])
  assert.equal((await call(unlinked, 'GET', '/timesheets')).status, 200)
})

test('role updates affect an existing session and cannot be self-granted by ordinary users', async () => {
  assert.equal((await call(basic, 'PUT', `/admin/users/${basic.id}`, { roles: ['admin'] })).status, 403)
  const response = await call(both, 'PUT', `/admin/users/${basic.id}`, { roles: ['admin'] })
  assert.equal(response.status, 200)
  assert.deepEqual(response.body.roles, ['user', 'admin'])
  assert.deepEqual(verifySession(basic.token).roles, ['user', 'admin'])
  assert.equal((await call(basic, 'GET', '/admin/users')).status, 200)
  assert.equal((await call(basic, 'GET', `/employees/${hr.employee}`)).status, 403)
  assert.equal((await call(both, 'PUT', `/admin/users/${basic.id}`, { roles: ['rh'] })).status, 200)
  assert.equal((await call(basic, 'GET', '/admin/users')).status, 403)
  assert.equal((await call(basic, 'GET', `/employees/${hr.employee}`)).status, 200)
  assert.equal((await call(both, 'PUT', `/admin/users/${basic.id}`, { roles: ['unknown'] })).status, 400)
  await call(both, 'PUT', `/admin/users/${basic.id}`, { roles: [] })
})

test('bootstrap and realtime use the RH grant independently of Admin', () => {
  for (const actor of actors) {
    const user = verifySession(actor.token)
    const allowed = actor.roles.includes('rh')
    assert.equal('employees' in filterCachedSpecs({ employees: {}, orders: {} }, user), allowed)
    assert.equal(canReceiveChannel(user, 'employee:someone-else'), allowed)
    assert.equal(canReceiveChannel(user, 'paie:all'), allowed)
    assert.equal(canReceiveChannel(user, 'comments:employee:someone-else'), allowed)
    assert.equal(canReceiveChannel(user, 'agent:task'), actor.roles.includes('admin'))
  }
})


test('an admin without RH can link accounts using a minimal employee directory', async () => {
  const response = await call(adminOnly, 'GET', '/admin/employee-options')
  assert.equal(response.status, 200)
  assert.ok(response.body.data.some(e => e.id === hr.employee))
  for (const row of response.body.data) assert.deepEqual(Object.keys(row).sort(), ['first_name', 'id', 'last_name'])
  assert.equal((await call(basic, 'GET', '/admin/employee-options')).status, 403)
})

test('new accounts accept cumulative grants and default to base access', async () => {
  for (const roles of [undefined, [], ['admin'], ['rh'], ['admin', 'rh']]) {
    const response = await call(adminOnly, 'POST', '/admin/users', {
      name: 'New test account', email: `roles-${Math.random()}@example.invalid`, password: 'test-password-only',
      ...(roles === undefined ? {} : { roles }),
    })
    assert.equal(response.status, 201, JSON.stringify(response.body))
    assert.deepEqual(response.body.roles, ['user', ...(roles || [])])
  }
  const invalid = await call(adminOnly, 'POST', '/admin/users', { name: 'Invalid', email: 'invalid@example.invalid', password: 'test-password', roles: 'admin' })
  assert.equal(invalid.status, 400)
})


test('RH manages activity codes; everyone can choose codes for their own timesheet', async () => {
  for (const actor of actors) {
    const allHR = actor.roles.includes('rh')
    assert.equal((await call(actor, 'GET', '/activity-codes')).status, 200)
    assert.equal((await call(actor, 'GET', '/activity-codes?all=1')).status, allHR ? 200 : 403)
    assert.equal((await call(actor, 'GET', `/activity-codes?for_user_id=${both.id}`)).status, allHR ? 200 : 403)
    assert.equal((await call(actor, 'POST', '/activity-codes', { name: `Role test ${actor.id}` })).status, allHR ? 201 : 403)
  }
})
