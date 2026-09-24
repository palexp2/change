// Navigateur sur le build local, API simulée : aucune connexion à la production.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')

describe('Commande — retrait du prélèvement', () => {
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

  async function setup(t, { fail = false, mobile = false, scan = false } = {}) {
    const ctx = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1360, height: 1000 } })
    t.after(() => ctx.close())
    const page = await ctx.newPage()
    const errors = [], mutations = []
    page.on('pageerror', e => errors.push(e.message))
    const order = {
      id: 'unpick-demo', order_number: 123, status: 'En cours', company_name: 'Test', shipments: [],
      items: [
        { id: 'pending', product_name: 'À préparer', qty: 1, fulfilled_qty: 0, fulfillment_status: 'À prélever', serials: [], product_serial_count: 0 },
        { id: 'bulk', product_name: 'Câbles', qty: 5, fulfilled_qty: 5, fulfillment_status: 'Prélevé', serials: [], product_serial_count: 0 },
        { id: 'serial', product_name: 'Capteurs', qty: 2, fulfilled_qty: 2, fulfillment_status: 'Prélevé', serials: [{ id: 's1', serial: 'TEST001' }, { id: 's2', serial: 'TEST002' }], product_serial_count: 2 },
      ],
    }
    if (scan) order.items = [{ ...order.items[2], fulfillment_status: 'À prélever', fulfilled_qty: 0, serials: [] }]
    const token = `test.${Buffer.from(JSON.stringify({ id: 'test', name: 'Test', role: 'admin' })).toString('base64')}.test`
    await ctx.addInitScript(token => localStorage.setItem('erp_token', token), token)
    await page.route('**/api/**', async route => {
      const req = route.request(), url = new URL(req.url())
      const endpoint = url.pathname.replace(/^\/erp\/api/, '')
      if (endpoint.startsWith('/telemetry/')) return route.fulfill({ json: { ok: true } })
      if (scan && req.method() === 'POST' && endpoint === '/orders/unpick-demo/scan') {
        const serial = { id: 's3', serial: 'TEST003', product_name: 'Capteurs' }
        const item = order.items[0]
        item.fulfilled_qty = 1
        item.serials = [serial]
        return route.fulfill({ json: { type: 'serial', action: 'picked', serial, item } })
      }
      if (req.method() === 'POST' && endpoint.endsWith('/unpick')) {
        const body = req.postDataJSON()
        mutations.push(body)
        if (fail) return route.fulfill({ status: 409, json: { error: 'Le prélèvement a changé. Actualisez la commande.' } })
        const item = order.items.find(i => endpoint.includes(`/items/${i.id}/`))
        assert.equal(body.expected_fulfilled_qty, item.fulfilled_qty)
        item.fulfilled_qty -= body.serial_id ? 1 : body.quantity
        item.fulfillment_status = 'À prélever'
        item.serials = item.serials.filter(s => s.id !== body.serial_id)
        return route.fulfill({ json: item })
      }
      if (req.method() !== 'GET') {
        mutations.push({ unexpected: endpoint, method: req.method() })
        return route.fulfill({ status: 400, json: { error: 'Unexpected mutation' } })
      }
      if (endpoint === '/orders/unpick-demo') return route.fulfill({ json: order })
      if (endpoint.startsWith('/bootstrap')) return route.fulfill({ json: { tables: {}, snapshot_ts: new Date().toISOString() } })
      if (endpoint.includes('/preferences')) return route.fulfill({ json: {} })
      if (endpoint === '/novoxpress/status') return route.fulfill({ json: { configured: false } })
      return route.fulfill({ json: { data: [], total: 0 } })
    })
    await page.goto(`${base}/orders/unpick-demo?mode=expedition`)
    await page.getByTestId('expedition-view').waitFor()
    return { page, mutations, errors }
  }

  test('retirer plusieurs exemplaires pendant la préparation, sans déclencher le clic de ligne', async t => {
    const { page, mutations, errors } = await setup(t)
    const adjustment = page.getByTestId('pick-adjustment-bulk')
    await adjustment.locator('summary').click()
    await adjustment.getByLabel(/Quantité à remettre/).fill('2')
    await adjustment.getByRole('button', { name: 'Retirer', exact: true }).click()
    await page.getByText('Prélèvement mis à jour').waitFor()
    assert.deepEqual(mutations, [{ quantity: 2, expected_fulfilled_qty: 5 }])
    // La ligne partielle est désormais dans la file ; on passe le premier article.
    await page.getByRole('button', { name: 'Passer', exact: true }).click()
    await page.getByTestId('pick-hero').getByText('3/5', { exact: true }).waitFor()
    assert.deepEqual(errors, [])
  })

  test('retirer une série précise préserve l’autre et la quantité restante', async t => {
    const { page, mutations, errors } = await setup(t)
    const adjustment = page.getByTestId('pick-adjustment-serial')
    await adjustment.locator('summary').click()
    await adjustment.getByRole('button', { name: 'Retirer TEST001', exact: true }).click()
    await page.getByText('Prélèvement mis à jour').waitFor()
    assert.deepEqual(mutations, [{ serial_id: 's1', expected_fulfilled_qty: 2 }])
    await page.getByRole('button', { name: 'Passer', exact: true }).click()
    const hero = page.getByTestId('pick-hero')
    await hero.getByText('1/2', { exact: true }).waitFor()
    assert.equal(await hero.getByText('TEST001', { exact: true }).count(), 0)
    assert.equal(await hero.getByText('TEST002', { exact: true }).first().isVisible(), true)
    assert.deepEqual(errors, [])
  })

  test('une erreur reste visible et conserve le prélèvement ; quantités invalides bloquées', async t => {
    const { page, mutations, errors } = await setup(t, { fail: true, mobile: true })
    const adjustment = page.getByTestId('pick-adjustment-bulk')
    await adjustment.locator('summary').click()
    const input = adjustment.getByLabel(/Quantité à remettre/)
    const button = adjustment.getByRole('button', { name: 'Retirer', exact: true })
    for (const value of ['0', '6', '1.5']) {
      await input.fill(value)
      assert.equal(await button.isDisabled(), true)
    }
    await input.fill('1')
    await button.click()
    await adjustment.getByRole('alert').waitFor()
    assert.match(await adjustment.innerText(), /5 prélevés/)
    assert.equal(mutations.length, 1, JSON.stringify(mutations))
    const box = await button.boundingBox()
    assert.ok(box.x >= 0 && box.x + box.width <= 390, 'action visible sur mobile')
    assert.deepEqual(errors, [])
  })

  test('une série scannée peut être retirée immédiatement sans recharger', async t => {
    const { page, mutations, errors } = await setup(t, { scan: true })
    await page.getByTestId('manual-scan-input').fill('TEST003')
    await page.getByTestId('manual-scan-form').locator('button[type="submit"]').click()
    const adjustment = page.getByTestId('pick-adjustment-serial')
    await adjustment.locator('summary').click()
    await adjustment.getByRole('button', { name: 'Retirer TEST003', exact: true }).click()
    await page.getByText('Prélèvement mis à jour').waitFor()
    assert.deepEqual(mutations, [{ serial_id: 's3', expected_fulfilled_qty: 1 }])
    assert.equal(await page.getByTestId('pick-hero').getByText('TEST003', { exact: true }).count(), 0)
    assert.deepEqual(errors, [])
  })
})
