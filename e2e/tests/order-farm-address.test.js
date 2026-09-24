// Navigateur sur le build local, API simulée : aucune connexion à la production.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')

describe('Commande — ouverture de l’adresse de ferme', () => {
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


  for (const scenario of ['admin', 'user', 'stale-module']) test(`le lien ouvre la fiche adresse et revient à la commande (${scenario})`, async t => {
    const role = scenario === 'user' ? 'user' : 'admin'
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } })
    t.after(() => ctx.close())
    await ctx.routeWebSocket('**/ws**', () => {})
    const page = await ctx.newPage()
    page.setDefaultTimeout(8000)
    const errors = []
    let failedImports = 0
    if (scenario === 'stale-module') await page.route('**/assets/AdresseDetail-*.js', route => {
      if (failedImports++ === 0) return route.abort()
      return route.continue()
    })
    page.on('pageerror', e => errors.push(e.message))
    page.on('console', m => { if (m.type() === 'error' && m.text().includes('[ErrorBoundary]')) errors.push(m.text()) })
    const orderId = '212ae92b-0f4e-4713-aa55-f4728330b3cc'
    const address = { id: '1', line1: '10 rue de la Ferme', city: 'Québec', province: 'QC', country: 'CA', address_type: 'Ferme' }
    const order = { id: orderId, order_number: 123, status: 'En cours', items: [], shipments: [], farm_address_id: address.id, farm_address: address }
    const token = `test.${Buffer.from(JSON.stringify({ id: 'test', name: 'Test', role })).toString('base64')}.test`
    await ctx.addInitScript(token => localStorage.setItem('erp_token', token), token)
    await page.route('**/api/**', async route => {
      const endpoint = new URL(route.request().url()).pathname.replace(/^\/erp\/api/, '')
      if (endpoint === `/orders/${orderId}`) return route.fulfill({ json: order })
      if (endpoint === '/projets/adresses/1') return route.fulfill({ json: address })
      if (endpoint.startsWith('/bootstrap')) return route.fulfill({ json: { tables: {}, snapshot_ts: new Date().toISOString() } })
      if (endpoint.startsWith('/views/')) return route.fulfill({ json: { config: {}, pills: [], dynamicFields: [] } })
      if (endpoint.includes('/preferences')) return route.fulfill({ json: {} })
      return route.fulfill({ json: { data: [], total: 0 } })
    })
    await page.goto(`${base}/orders/${orderId}`)
    await page.getByTestId('detail-field-farm_address_id').locator('a[href$="/adresses/1"]').click()
    await page.getByTestId('adresse-field-line1').waitFor()
    assert.equal(await page.getByTestId('adresse-field-line1').inputValue(), address.line1)
    if (scenario === 'stale-module') {
      assert.ok(failedImports >= 2, 'le module est rechargé après récupération')
      assert.ok(errors.every(message => /dynamically imported module|Failed to fetch/.test(message)), errors.join('\n'))
      assert.equal(await page.getByTestId('error-boundary-fallback').count(), 0)
    } else assert.deepEqual(errors, [])
    await page.goBack()
    await page.waitForURL(`**/orders/${orderId}`)
    await page.locator('a[href$="/adresses/1"]').first().waitFor()
    if (scenario === 'stale-module') {
      assert.ok(failedImports >= 2, 'le module est rechargé après récupération')
      assert.ok(errors.every(message => /dynamically imported module|Failed to fetch/.test(message)), errors.join('\n'))
      assert.equal(await page.getByTestId('error-boundary-fallback').count(), 0)
    } else assert.deepEqual(errors, [])
  })
})
