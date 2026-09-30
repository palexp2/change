// Navigateur sur le build local, API simulée : aucune connexion à la production.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')

describe('Commande — lien System Builder et notes', () => {
  let server, browser, base
  before(async () => {
    const root = process.env.ERP_TEST_DIST || path.resolve(__dirname, '../../client/dist')
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



  for (const scenario of ['legacy-empty', 'legacy-notes', 'new', 'ordinary']) test(scenario, async t => {
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } })
    t.after(() => ctx.close())
    await ctx.routeWebSocket('**/ws**', socket => {
      socket.onMessage(message => {
        if (JSON.parse(message).type === 'auth') socket.send(JSON.stringify({ type: 'auth:success' }))
      })
    })
    const page = await ctx.newPage()
    page.setDefaultTimeout(8000)
    const errors = []
    page.on('pageerror', e => errors.push(e.message))
    const orderId = '212ae92b-0f4e-4713-aa55-f4728330b3cc'
    const formId = 'borWAkQoARPd2bfgb'
    const marker = `System Builder #${formId}`
    const notes = scenario === 'legacy-empty' ? marker
      : scenario === 'legacy-notes' ? `${marker}\nPréparer les contrôleurs.\nLivrer lundi.`
      : scenario === 'ordinary' ? marker : ''
    const expected = scenario === 'legacy-notes' ? 'Préparer les contrôleurs.\nLivrer lundi.'
      : scenario === 'ordinary' ? marker : ''
    const order = {
      id: orderId, order_number: 123, status: 'En cours', items: [], shipments: [], notes,
      discovery_forms: scenario === 'ordinary' ? [] : [{ id: formId, created_at: '2026-09-29T12:00:00Z' }],
    }
    const writes = []
    const token = `test.${Buffer.from(JSON.stringify({ id: 'test', name: 'Test', role: 'admin' })).toString('base64')}.test`
    await ctx.addInitScript(token => localStorage.setItem('erp_token', token), token)
    await page.route('**/api/**', async route => {
      const endpoint = new URL(route.request().url()).pathname.replace(/^\/erp\/api/, '')
      if (endpoint === '/auth/users') return route.fulfill({ json: [] })
      if (endpoint === '/auth/me') return route.fulfill({ json: { id: 'test', name: 'Test', role: 'admin' } })
      if (endpoint === `/orders/${orderId}`) {
        if (route.request().method() === 'PUT') {
          const update = route.request().postDataJSON()
          writes.push(update)
          Object.assign(order, update)
        }
        return route.fulfill({ json: order })
      }
      if (endpoint.startsWith('/bootstrap')) return route.fulfill({ json: { tables: {}, snapshot_ts: new Date().toISOString() } })
      if (endpoint.startsWith('/views/')) return route.fulfill({ json: { config: {}, pills: [], dynamicFields: [] } })
      if (endpoint.includes('/preferences')) return route.fulfill({ json: {} })
      return route.fulfill({ json: { data: [], total: 0 } })
    })
    await page.goto(`${base}/orders/${orderId}`)
    const input = page.getByTestId('order-notes-input')
    await input.waitFor().catch(async error => {
      throw new Error(`${error.message}\nURL: ${page.url()}\n${errors.join('\n')}\n${(await page.locator('body').innerText()).slice(0, 3000)}`)
    })
    assert.equal(await input.inputValue(), expected)
    if (scenario !== 'ordinary') {
      const link = page.getByTestId('detail-field-discovery_forms').locator(`a[href$="/discovery-forms/${formId}"]`)
      await link.waitFor({ state: 'visible' })
    }
    await input.focus()
    await input.blur()
    assert.equal(writes.length, 0, 'Afficher les notes ne doit pas modifier la commande')
    await input.fill('Note personnelle')
    const saved = page.waitForResponse(r => r.url().endsWith(`/orders/${orderId}`) && r.request().method() === 'PUT')
    await input.blur()
    await saved
    assert.equal(order.notes, 'Note personnelle')
    await page.reload()
    await input.waitFor()
    assert.equal(await input.inputValue(), 'Note personnelle')
    assert.deepEqual(errors, [])
  })
})
