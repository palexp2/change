// Navigateur sur le build local, API simulée : aucune connexion à la production.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')

describe('Commande — sélection des liens de série', () => {
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


  async function setup(t, fail = false) {
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } })
    t.after(() => ctx.close())
    await ctx.routeWebSocket('**/ws**', () => {})
    const page = await ctx.newPage()
    page.setDefaultTimeout(8000)
    const mutations = [], errors = []
    page.on('pageerror', e => errors.push(e.message))
    const keys = ['rec00000000000001', 'rec00000000000002']
    const item = {
      id: 'line', product_name: 'Produit', qty: 2, fulfilled_qty: 2, serials: [],
      de_serie: JSON.stringify(keys),
      de_serie_serials: keys.map((key, i) => ({ id: String(i + 1), airtable_id: key, serial: `BL410${i}` })),
    }
    const order = { id: 'serial-demo', order_number: 123, status: 'En cours', items: [item], shipments: [] }
    const token = `test.${Buffer.from(JSON.stringify({ id: 'test', name: 'Test', role: 'admin' })).toString('base64')}.test`
    await ctx.addInitScript(token => localStorage.setItem('erp_token', token), token)
    await page.route('**/api/**', async route => {
      const req = route.request(), endpoint = new URL(req.url()).pathname.replace(/^\/erp\/api/, '')
      if (endpoint.startsWith('/telemetry/')) return route.fulfill({ json: { ok: true } })
      if (req.method() === 'PATCH' && endpoint === '/orders/serial-demo/items/line') {
        const body = req.postDataJSON()
        mutations.push(body)
        if (fail) return route.fulfill({ status: 400, json: { error: 'Dissociation refusée' } })
        item.de_serie = body.de_serie
        item.de_serie_serials = item.de_serie_serials.filter(s => JSON.parse(body.de_serie).includes(s.airtable_id))
        return route.fulfill({ json: item })
      }
      if (req.method() !== 'GET') return route.fulfill({ json: { ok: true } })
      if (endpoint === '/orders/serial-demo') return route.fulfill({ json: order })
      if (endpoint === '/serials/1') return route.fulfill({ json: { id: '1', serial: 'BL4100' } })
      if (endpoint.startsWith('/bootstrap')) return route.fulfill({ json: { tables: {}, snapshot_ts: new Date().toISOString() } })
      if (endpoint.startsWith('/views/')) return route.fulfill({ json: { config: { visible_columns: ['product_id', 'de_serie'], default_sort: [] }, pills: [], dynamicFields: [] } })
      if (endpoint.includes('/preferences')) return route.fulfill({ json: {} })
      return route.fulfill({ json: { data: [], total: 0 } })
    })
    await page.goto(`${base}/orders/serial-demo`)
    const cell = page.locator('[data-grid-cell="line|de_serie"]')
    await cell.getByText('BL4100', { exact: true }).waitFor()
    return { page, cell, mutations, errors }
  }

  // Vrai clic aux coordonnées du lien : son premier état neutralise les
  // pointeurs, donc locator.click() attendrait indéfiniment qu'il soit actif.
  async function clickLabel(page, cell, label) {
    const box = await cell.getByText(label, { exact: true }).boundingBox()
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  }

  test('premier clic : sélection et X ; second clic : panneau de la série', async t => {
    const { page, cell, errors } = await setup(t)
    assert.equal(await cell.getByRole('button', { name: 'Dissocier', exact: true }).count(), 0)
    await clickLabel(page, cell, 'BL4100')
    await cell.getByTestId('link-chip-remove-rec00000000000001').waitFor()
    assert.match(await cell.getAttribute('class'), /ring-brand-500/)
    assert.match(page.url(), /\/orders\/serial-demo$/)
    assert.equal(await cell.getByTestId('link-chip-add').count(), 0)
    await clickLabel(page, cell, 'BL4100')
    await page.waitForURL('**/serials/1')
    assert.deepEqual(errors, [])
  })

  test('le X retire uniquement le lien choisi et le changement survit au rechargement', async t => {
    const { page, cell, mutations, errors } = await setup(t)
    await clickLabel(page, cell, 'BL4100')
    await cell.getByTestId('link-chip-remove-rec00000000000001').click()
    await cell.getByText('BL4100', { exact: true }).waitFor({ state: 'hidden' })
    assert.deepEqual(mutations, [{ de_serie: '["rec00000000000002"]' }])
    assert.match(page.url(), /\/orders\/serial-demo$/)
    await page.reload()
    await cell.getByText('BL4101', { exact: true }).waitFor()
    assert.equal(await cell.getByText('BL4100', { exact: true }).count(), 0)
    assert.deepEqual(errors, [])
  })

  test('une erreur conserve le lien et affiche la raison du refus', async t => {
    const { page, cell, errors } = await setup(t, true)
    await clickLabel(page, cell, 'BL4100')
    await cell.getByTestId('link-chip-remove-rec00000000000001').click()
    await page.getByText('Dissociation refusée', { exact: true }).waitFor()
    assert.equal(await cell.getByText('BL4100', { exact: true }).count(), 1)
    assert.match(page.url(), /\/orders\/serial-demo$/)
    assert.deepEqual(errors, [])
  })
})
