const { test, before, after, describe } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')

// Build réel, API simulée : aucune lecture ni écriture de données de production.
// Enveloppé dans describe : sous Node 18, un after() de premier niveau n'est joué
// qu'une fois la boucle vide — un navigateur ouvert l'en empêche, le test pend.
describe('product-scan', () => {
let server, browser, base
before(async () => {
  const root = path.resolve(__dirname, '../../client/dist')
  server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname.replace(/^\/erp\/?/, '')
    let file = path.resolve(root, pathname)
    if (!file.startsWith(root + '/') || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html')
    res.setHeader('Content-Type', { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' }[path.extname(file)] || 'application/octet-stream')
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
  await new Promise(resolve => server.close(resolve))
})

const products = [
  { id: 'p1', sku: 'PIECE1', name_fr: 'Pièce visible', active: 1, type: 'Acheté' },
  { id: 'p2', sku: 'TH200', name_fr: 'Pièce masquée', active: 1, type: 'Fabriqué' },
  { id: 'p3', sku: 'OLD300', name_fr: 'Pièce inactive', active: 0, type: 'Fabriqué' },
]

test('scan depuis une vue filtrée : référence, série, erreurs, retour', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
  const page = await ctx.newPage()
  const errors = [], writes = []
  page.on('pageerror', error => errors.push(error.message))
  const user = { id: 'test', name: 'Test', email: 'test@example.test', role: 'admin' }
  await ctx.addInitScript(token => localStorage.setItem('erp_token', token), `test.${Buffer.from(JSON.stringify(user)).toString('base64')}.test`)
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url())
    const endpoint = url.pathname.replace(/^.*\/api/, '')
    if (req.method() !== 'GET') { writes.push({ endpoint, body: req.postDataJSON() }); return route.fulfill({ json: {} }) }
    if (endpoint === '/auth/me') return route.fulfill({ json: user })
    if (endpoint === '/bootstrap') {
      const columns = Object.keys(products[0])
      return route.fulfill({ json: { snapshot_ts: new Date().toISOString(), tables: { products: { columns, rows: products.map(p => columns.map(c => p[c])) } } } })
    }
    if (endpoint.startsWith('/views/')) return route.fulfill({ json: { config: { visible_columns: ['sku', 'name_fr', 'type'], default_sort: [] }, pills: [{ id: 'filtered', label: 'Achetés', filters: [{ field: 'type', op: 'is', value: 'Acheté' }] }, { id: 'other', label: 'Autre', filters: [{ field: 'type', op: 'is', value: 'Absent' }] }], dynamicFields: [] } })
    if (endpoint === '/serials') {
      const code = url.searchParams.get('search')
      if (code === 'FAIL') return route.fulfill({ status: 500, json: { error: 'Erreur simulée' } })
      if (code === 'SLOW') await new Promise(resolve => setTimeout(resolve, 400))
      return route.fulfill({ json: { data: code.toUpperCase() === 'SN200' ? [{ serial: 'SN200', product_id: 'p2' }, { serial: 'SN2000', product_id: 'p1' }] : [] } })
    }
    if (endpoint.startsWith('/custom-fields/')) return route.fulfill({ json: { fields: [], overrides: [], data: [] } })
    return route.fulfill({ json: { data: [], tables: {}, sections: [], rules: [], config: {}, pills: [] } })
  })
  try {
    await page.goto(`${base}/products?vue=filtered`)
    await page.getByText('Pièce visible', { exact: true }).waitFor()
    assert.equal(await page.getByText('Pièce masquée', { exact: true }).count(), 0)
    const scan = async code => {
      await page.evaluate(() => document.activeElement?.blur())
      await page.keyboard.type(code, { delay: 10 })
      await page.keyboard.press('Enter')
    }
    const manual = async code => {
      await page.locator('.card input').first().fill(code)
      await page.locator('.card input').first().press('Enter')
    }
    await scan('th200')
    await page.getByText('Pièce masquée', { exact: true }).waitFor()
    assert.match(page.url(), /vue=filtered/)
    assert.equal(await page.getByText('Pièce visible', { exact: true }).count(), 0)
    await manual('sn200')
    await page.getByText('Pièce masquée', { exact: true }).waitFor()
    assert.equal(await page.getByText('Pièce visible', { exact: true }).count(), 0)
    await scan('OLD300')
    await page.getByText('Pièce inactive', { exact: true }).waitFor()
    await scan('UNKNOWN')
    await page.getByText('Code inconnu', { exact: true }).waitFor()
    await scan('FAIL')
    await page.getByText('Recherche impossible', { exact: true }).waitFor()
    await scan('SLOW')
    await scan('TH200')
    await page.getByText('Pièce masquée', { exact: true }).waitFor()
    await page.waitForTimeout(550)
    assert.equal(await page.getByText('Pièce masquée', { exact: true }).count(), 1)
    await page.getByRole('button', { name: 'Revenir à la liste' }).click()
    await page.getByText('Pièce visible', { exact: true }).waitFor()
    assert.equal(await page.getByText('Pièce masquée', { exact: true }).count(), 0)
    await page.getByRole('button', { name: 'Autre', exact: true }).click()
    await scan('TH200')
    await page.getByText('Pièce masquée', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Achetés', exact: true }).click()
    await page.getByText('Pièce visible', { exact: true }).waitFor()
    assert.equal(await page.getByTestId('product-scan-filter').count(), 0)
    assert.deepEqual(errors, [])
    // L'autosave existant réenregistre la configuration au démontage. Les
    // filtres doivent rester identiques ; aucun scan ne modifie les produits.
    for (const { endpoint, body } of writes) {
      if (endpoint.startsWith('/telemetry/') || endpoint === '/views/products/pills/reorder') continue
      assert.ok(['/views/products/pills/filtered', '/views/products/pills/other'].includes(endpoint), endpoint)
      assert.deepEqual(body.filters, [{ field: 'type', op: 'is', value: endpoint.endsWith('/filtered') ? 'Acheté' : 'Absent' }])
    }
  } catch (error) { console.error('Browser errors:', errors); console.error((await page.locator('body').innerText()).slice(0, 2500)); throw error } finally { await ctx.close() }
})
})
