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
    await ctx.routeWebSocket('**/ws**', socket => {
      socket.onMessage(message => {
        if (JSON.parse(message).type === 'auth') socket.send(JSON.stringify({ type: 'auth:success' }))
      })
    })
    const page = await ctx.newPage()
    page.setDefaultTimeout(8000)
    const mutations = [], errors = []
    page.on('pageerror', e => errors.push(e.message))
    const keys = ['rec00000000000001', 'rec00000000000002']
    const item = {
      id: 'line', product_name: 'Produit', qty: 2, fulfilled_qty: 2, serials: [],
      de_serie: JSON.stringify(keys),
      de_serie_serials: keys.map((key, i) => ({ id: String(i + 1), airtable_id: key, serial: i === 0 ? 'ML144' : 'BL4101' })),
    }
    const order = { id: 'borthHVqVYEmWMyfd', order_number: 123, status: 'En cours', items: [item], shipments: [] }
    const token = `test.${Buffer.from(JSON.stringify({ id: 'test', name: 'Test', role: 'admin' })).toString('base64')}.test`
    await ctx.addInitScript(token => localStorage.setItem('erp_token', token), token)
    await page.route('**/api/**', async route => {
      const req = route.request(), endpoint = new URL(req.url()).pathname.replace(/^\/erp\/api/, '')
      if (endpoint === '/auth/users') return route.fulfill({ json: [] })
      if (endpoint === '/auth/me') return route.fulfill({ json: { id: 'test', name: 'Test', role: 'admin' } })
      if (endpoint.startsWith('/telemetry/')) return route.fulfill({ json: { ok: true } })
      if (req.method() === 'PATCH' && endpoint === '/orders/borthHVqVYEmWMyfd/items/line') {
        const body = req.postDataJSON()
        mutations.push(body)
        if (fail) return route.fulfill({ status: 400, json: { error: 'Dissociation refusée' } })
        item.de_serie = body.de_serie
        item.de_serie_serials = item.de_serie_serials.filter(s => JSON.parse(body.de_serie).includes(s.airtable_id))
        return route.fulfill({ json: item })
      }
      if (req.method() !== 'GET') return route.fulfill({ json: { ok: true } })
      if (endpoint === '/orders/borthHVqVYEmWMyfd') return route.fulfill({ json: order })
      if (endpoint === '/serials/1') return route.fulfill({ json: { id: '1', serial: 'ML144' } })
      if (endpoint.startsWith('/bootstrap')) return route.fulfill({ json: { tables: {}, snapshot_ts: new Date().toISOString() } })
      if (endpoint.startsWith('/views/')) return route.fulfill({ json: { config: { visible_columns: ['product_id', 'de_serie'], default_sort: [] }, pills: [], dynamicFields: [] } })
      if (endpoint.includes('/preferences')) return route.fulfill({ json: {} })
      return route.fulfill({ json: { data: [], total: 0 } })
    })
    await page.goto(`${base}/orders/borthHVqVYEmWMyfd`)
    const cell = page.locator('[data-grid-cell="line|de_serie"]')
    await cell.getByText('ML144', { exact: true }).waitFor().catch(async error => {
      throw new Error(`${error.message}\nURL: ${page.url()}\n${errors.join('\n')}\n${(await page.locator('body').innerText()).slice(0, 3000)}`)
    })
    return { page, cell, mutations, errors }
  }

  test('un clic sur le numéro ouvre sa fiche latérale sans modifier les liens', async t => {
    const { page, cell, mutations, errors } = await setup(t)
    assert.equal(await cell.getByRole('button', { name: 'Dissocier', exact: true }).count(), 0)
    await cell.getByRole('link', { name: 'ML144', exact: true }).click()
    await page.waitForURL('**/serials/1')
    await page.getByTestId('serial-fields').waitFor()
    await page.getByTestId('record-peek-title').getByText('ML144', { exact: true }).waitFor()
    assert.equal(await page.getByTestId('record-peek-drawer').count(), 1)
    assert.deepEqual(mutations, [])
    await page.getByTestId('record-peek-close').last().click()
    await page.waitForURL('**/orders/borthHVqVYEmWMyfd')
    await cell.getByRole('link', { name: 'ML144', exact: true }).waitFor()
    assert.deepEqual(errors, [])
  })

  test('le X retire uniquement le lien choisi et le changement survit au rechargement', async t => {
    const { page, cell, mutations, errors } = await setup(t)
    await cell.click({ position: { x: 5, y: 12 } })
    await cell.getByTestId('link-chip-remove-rec00000000000001').click()
    await cell.getByText('ML144', { exact: true }).waitFor({ state: 'hidden' })
    assert.deepEqual(mutations, [{ de_serie: '["rec00000000000002"]' }])
    assert.match(page.url(), /\/orders\/borthHVqVYEmWMyfd$/)
    await page.reload()
    await cell.getByText('BL4101', { exact: true }).waitFor()
    assert.equal(await cell.getByText('ML144', { exact: true }).count(), 0)
    assert.deepEqual(errors, [])
  })

  test('une erreur conserve le lien et affiche la raison du refus', async t => {
    const { page, cell, errors } = await setup(t, true)
    await cell.click({ position: { x: 5, y: 12 } })
    await cell.getByTestId('link-chip-remove-rec00000000000001').click()
    await page.getByText('Dissociation refusée', { exact: true }).waitFor()
    assert.equal(await cell.getByText('ML144', { exact: true }).count(), 1)
    assert.match(page.url(), /\/orders\/borthHVqVYEmWMyfd$/)
    assert.deepEqual(errors, [])
  })
})
