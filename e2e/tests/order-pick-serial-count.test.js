// Navigateur sur le build local, API simulée : aucune connexion à la production.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')

describe('Envois — séries distinctes avant validation', () => {
  let server, browser, base
  before(async () => {
    const root = path.resolve(__dirname, '../../client/dist')
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

  async function setup(t, { legacy = false } = {}) {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 1000 } })
    t.after(() => ctx.close())
    await ctx.route('**/*', route => new URL(route.request().url()).origin === new URL(base).origin
      ? route.fallback() : route.abort())
    const page = await ctx.newPage()
    const errors = [], mutations = []
    page.on('pageerror', e => errors.push(e.message))
    const order = {
      id: 'serial-count-demo', order_number: 123, status: 'En cours', company_name: 'Test', shipments: [],
      items: [
        { id: 'serial', product_name: 'Boîtiers louvre', qty: 2, product_serial_count: 2,
          fulfillment_status: legacy ? 'Prélevé' : 'À prélever', fulfilled_qty: legacy ? 2 : 0,
          serials: legacy ? [{ id: 'TEST001', serial: 'TEST001' }] : [] },
        { id: 'next', product_name: 'Article suivant', qty: 1, fulfilled_qty: 0,
          fulfillment_status: 'À prélever', serials: [], product_serial_count: 0 },
      ],
    }
    const token = `test.${Buffer.from(JSON.stringify({ id: 'test', name: 'Test', role: 'admin' })).toString('base64')}.test`
    await ctx.addInitScript(token => localStorage.setItem('erp_token', token), token)
    await page.route('**/api/**', async route => {
      const req = route.request(), url = new URL(req.url())
      const endpoint = url.pathname.replace(/^\/erp\/api/, '')
      if (endpoint.startsWith('/telemetry/')) return route.fulfill({ json: { ok: true } })
      if (req.method() === 'POST' && endpoint === '/orders/serial-count-demo/scan') {
        const value = req.postDataJSON().value
        const serial = { id: value, serial: value, product_name: 'Boîtiers louvre' }
        const item = order.items[0]
        if (!item.serials.some(s => s.id === value)) item.serials.push(serial)
        item.fulfilled_qty = item.serials.length
        item.fulfillment_status = item.fulfilled_qty >= item.qty ? 'Prélevé' : 'À prélever'
        return route.fulfill({ json: { type: 'serial', action: 'picked', serial, item } })
      }
      if (req.method() !== 'GET') {
        mutations.push({ unexpected: endpoint, method: req.method() })
        return route.fulfill({ status: 400, json: { error: 'Unexpected mutation' } })
      }
      if (endpoint === '/orders/serial-count-demo') return route.fulfill({ json: order })
      if (endpoint.startsWith('/bootstrap')) return route.fulfill({ json: { tables: {}, snapshot_ts: new Date().toISOString() } })
      if (endpoint.includes('/preferences')) return route.fulfill({ json: {} })
      if (endpoint === '/novoxpress/status') return route.fulfill({ json: { configured: false } })
      return route.fulfill({ json: { data: [], total: 0 } })
    })
    await page.goto(`${base}/orders/serial-count-demo?mode=expedition`)
    await page.getByTestId('expedition-view').waitFor()
    return { page, mutations, errors }
  }

  async function scanSerial(page, serial) {
    await page.getByTestId('manual-scan-input').fill(serial)
    const response = page.waitForResponse(r => r.url().endsWith('/orders/serial-count-demo/scan'))
    await page.getByTestId('manual-scan-form').locator('button[type="submit"]').click()
    await response
  }

  test('la saisie manuelle en minuscules suivie d’Entrée déclenche un seul prélèvement', async t => {
    const { page, mutations, errors } = await setup(t)
    const scans = []
    page.on('request', req => {
      if (req.url().endsWith('/orders/serial-count-demo/scan')) scans.push(req.postDataJSON())
    })
    const input = page.getByTestId('manual-scan-input')
    await input.fill(' dc6461 ')
    const response = page.waitForResponse(r => r.url().endsWith('/orders/serial-count-demo/scan'))
    await input.press('Enter')
    await response
    await page.getByTestId('pick-hero').getByText('1/2', { exact: true }).waitFor()
    await page.waitForFunction(() => document.querySelector('[data-testid="manual-scan-input"]').value === '')
    assert.equal(scans.length, 1)
    assert.equal(scans[0].value, 'dc6461')
    assert.equal(scans[0].mode, 'pick')
    assert.deepEqual(mutations, [])
    assert.deepEqual(errors, [])
  })

  test('le clic et un scan répété ne passent pas au prochain article ; la deuxième série le permet', async t => {
    const { page, mutations, errors } = await setup(t)
    const hero = page.getByTestId('pick-hero')
    await hero.getByText('Boîtiers louvre', { exact: true }).click()
    await page.getByText('Scannez un numéro de série distinct par exemplaire.', { exact: true }).waitFor()
    assert.deepEqual(mutations, [])
    await scanSerial(page, 'TEST001')
    await hero.getByText('1/2', { exact: true }).waitFor()
    await hero.getByText('Boîtiers louvre', { exact: true }).click()
    assert.deepEqual(mutations, [])
    await scanSerial(page, 'TEST001')
    await hero.getByText('1/2', { exact: true }).waitFor()
    await scanSerial(page, 'TEST002')
    await hero.getByText('Article suivant', { exact: true }).waitFor()
    assert.deepEqual(errors, [])
  })

  test('une ancienne ligne complète avec une seule série revient dans la préparation', async t => {
    const { page, mutations, errors } = await setup(t, { legacy: true })
    const hero = page.getByTestId('pick-hero')
    await hero.getByText('Boîtiers louvre', { exact: true }).waitFor()
    await hero.getByText('1/2', { exact: true }).waitFor()
    await scanSerial(page, 'TEST002')
    await hero.getByText('Article suivant', { exact: true }).waitFor()
    assert.deepEqual(mutations, [])
    assert.deepEqual(errors, [])
  })
})
