// Local build and mocked API only; authorization is covered by route tests.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')
describe('Additive roles UI', () => {
let server, browser, base
before(async () => {
  const root = path.resolve(__dirname, '../../client', process.env.ERP_TEST_BUILD || 'dist')
  server = http.createServer((req, res) => {
    const relative = new URL(req.url, 'http://localhost').pathname.replace(/^\/erp\/?/, '')
    let file = path.resolve(root, relative)
    if (!file.startsWith(root + '/') || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html')
    res.setHeader('Content-Type', { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream')
    fs.createReadStream(file).pipe(res)
  })
  server.on('upgrade', (_req, socket) => socket.destroy())
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}/erp`
  browser = await chromium.launch({ headless: true })
})
after(async () => {
  await browser?.close()
  server?.closeAllConnections()
  await new Promise(resolve => server ? server.close(resolve) : resolve())
})
async function setup(t, roles, mobile = false) {
  const ctx = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1360, height: 1000 } })
  t.after(() => ctx.close())
  const page = await ctx.newPage()
  const errors = [], writes = []
  page.on('pageerror', e => errors.push(e.message))
  t.after(() => assert.deepEqual(errors, []))
  const user = { id: 'self', name: 'Self User', role: 'user', roles: ['user', ...roles], employee_id: '11111111-1111-4111-8111-111111111111' }
  const employee = { id: '11111111-1111-4111-8111-111111111111', first_name: 'Self', last_name: 'User', email_work: 'self@example.invalid', active: 1 }
  await ctx.addInitScript(token => localStorage.setItem('erp_token', token), `test.${Buffer.from(JSON.stringify(user)).toString('base64')}.test`)
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()), endpoint = url.pathname.replace(/^.*\/api/, '')
    if (req.method() !== 'GET') { writes.push({ endpoint, body: req.postDataJSON() }); return route.fulfill({ json: { id: 'new', ...req.postDataJSON() } }) }
    if (endpoint === '/auth/me') return route.fulfill({ json: user })
    if (endpoint === '/admin/users') return route.fulfill({ json: [{ ...user, active: 1, email: 'self@example.invalid' }] })
    if (endpoint === '/employees' || endpoint === '/admin/employee-options') return route.fulfill({ json: { data: [employee], total: 1 } })
    if (endpoint === '/employees/11111111-1111-4111-8111-111111111111') return route.fulfill({ json: employee })
    if (endpoint.startsWith('/bootstrap')) return route.fulfill({ json: { tables: {}, snapshot_ts: new Date().toISOString() } })
    if (endpoint.startsWith('/custom-fields/')) return route.fulfill({ json: [] })
    if (endpoint.includes('/preferences') || endpoint.startsWith('/views/')) return route.fulfill({ json: {} })
    return route.fulfill({ json: { data: [], total: 0 } })
  })
  return { page, writes }
}
for (const roles of [[], ['admin'], ['rh'], ['admin', 'rh']]) {
  test(`own employee page and editing actions: ${roles.join('+') || 'base'}`, async t => {
    const { page } = await setup(t, roles)
    await page.goto(`${base}/employees/11111111-1111-4111-8111-111111111111`)
    await page.getByTestId('employee-fields').waitFor({ timeout: 15000 })
    const fields = page.getByTestId('employee-fields')
    const isHR = roles.includes('rh')
    if (isHR) await fields.locator('input').first().waitFor()
    assert.equal(await fields.locator('input, textarea, select').count() > 0, isHR)
    assert.equal(await page.getByRole('button', { name: 'Supprimer cet employé' }).count(), isHR ? 1 : 0)
    if (!isHR) assert.ok((await fields.textContent()).includes('self@example.invalid'))
  })
}
test('role checkboxes are cumulative and base access is mandatory', async t => {
  const { page, writes } = await setup(t, ['admin'], true)
  await page.goto(`${base}/parametres/utilisateurs`)
  await page.getByRole('button', { name: 'Nouvel utilisateur' }).click()
  const modal = page.getByRole('dialog')
  const baseRole = modal.getByLabel('Utilisateur', { exact: true })
  assert.equal(await baseRole.isChecked(), true)
  assert.equal(await baseRole.isDisabled(), true)
  await modal.getByLabel('Admin', { exact: true }).check()
  await modal.getByLabel('RH', { exact: true }).check()
  assert.equal(await modal.getByLabel('Admin', { exact: true }).isChecked(), true)
  assert.equal(await modal.getByLabel('RH', { exact: true }).isChecked(), true)
  await modal.locator('input').nth(0).fill('New User')
  await modal.locator('input[type=email]').fill('new@example.invalid')
  await modal.locator('input[type=password]').fill('test-password')
  await modal.locator('button[type=submit]').click()
  await modal.waitFor({ state: 'hidden' })
  const write = writes.find(w => w.endpoint === '/admin/users')
  assert.deepEqual(write.body.roles, ['user', 'admin', 'rh'])
})

})
