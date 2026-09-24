const { test, before, after, describe } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')

// Build réel, API simulée : aucune lecture ni écriture de données de production.
// Enveloppé dans describe : sous Node 18, un after() de premier niveau n'est joué
// qu'une fois la boucle vide — un navigateur ouvert l'en empêche, le test pend.
describe('product-search-views', () => {
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
  { id: 'p1', sku: '1200', name_fr: 'Produit à acheter', active: 1, order_qty: 5 },
  { id: 'p2', sku: '1353', name_fr: 'Produit en stock', active: 1, order_qty: 0 },
]

for (const mode of ['general', 'matching', 'no-view']) {
  test(`recherche produit hors de la vue À acheter : ${mode}`, async () => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    const page = await ctx.newPage()
    const errors = [], writes = []
    page.on('pageerror', error => errors.push(error.message))
    const user = { id: 'test', name: 'Test', email: 'test@example.test', role: 'admin' }
    await ctx.addInitScript(token => localStorage.setItem('erp_token', token), `test.${Buffer.from(JSON.stringify(user)).toString('base64')}.test`)
    const buyFilters = [{ field: 'order_qty', op: 'gt', value: 0 }]
    const pills = [{ id: 'buy', label: 'À acheter', filters: buyFilters, locked: true }]
    if (mode !== 'no-view') pills.push({ id: 'stock', label: mode === 'general' ? 'Tous les produits' : 'En stock', locked: true,
      filters: mode === 'general' ? [] : { conjunction: 'AND', rules: [{ field: 'order_qty', op: 'eq', value: 0 }] } })
    await page.route('**/api/**', async route => {
      const req = route.request(), endpoint = new URL(req.url()).pathname.replace(/^.*\/api/, '')
      if (req.method() !== 'GET') { writes.push(endpoint); return route.fulfill({ json: {} }) }
      if (endpoint === '/auth/me') return route.fulfill({ json: user })
      if (endpoint === '/bootstrap') {
        const columns = Object.keys(products[0])
        return route.fulfill({ json: { snapshot_ts: new Date().toISOString(), tables: { products: { columns, rows: products.map(p => columns.map(c => p[c])) } } } })
      }
      if (endpoint.startsWith('/views/')) return route.fulfill({ json: { config: { visible_columns: ['sku', 'name_fr', 'order_qty'], default_sort: [] }, pills, dynamicFields: [] } })
      if (endpoint.startsWith('/custom-fields/')) return route.fulfill({ json: { fields: [], overrides: [], data: [] } })
      return route.fulfill({ json: { data: [], tables: {}, sections: [], rules: [], config: {}, pills: [] } })
    })
    try {
      await page.goto(`${base}/products?vue=buy`)
      await page.getByText('Produit à acheter', { exact: true }).waitFor()
      const search = page.locator('input.input.pl-7')
      await search.fill('1200')
      await page.waitForTimeout(500)
      assert.match(page.url(), /vue=buy/)
      await search.fill('inexistant')
      await page.waitForTimeout(500)
      assert.match(page.url(), /vue=buy/)
      await search.fill('1353')
      await page.getByText('Produit en stock', { exact: true }).waitFor()
      await page.waitForTimeout(150)
      assert.equal(await search.inputValue(), '1353')
      assert.equal(await search.evaluate(el => document.activeElement === el), true)
      assert.equal(new URL(page.url()).searchParams.get('vue'), mode === 'no-view' ? null : 'stock')
      assert.equal(await page.getByText('Produit à acheter', { exact: true }).count(), 0)
      assert.deepEqual(writes.filter(endpoint => !endpoint.startsWith('/telemetry/')), [])
      // Le choix manuel après la bascule reste possible, même avec la recherche.
      await page.getByRole('button', { name: /À acheter/ }).click()
      await page.waitForTimeout(500)
      assert.match(page.url(), /vue=buy/)
      assert.equal(await page.getByText('Produit en stock', { exact: true }).count(), 0)
      await search.fill('')
      await page.getByText('Produit à acheter', { exact: true }).waitFor()
      assert.equal(await page.getByText('Produit en stock', { exact: true }).count(), 0)
      // Une saisie remplacée avant le délai ne doit pas provoquer de bascule.
      await search.fill('1353')
      await search.fill('1200')
      await page.waitForTimeout(500)
      assert.match(page.url(), /vue=buy/)
      assert.deepEqual(errors, [])
      // Le clic admin sur un onglet persiste déjà son ordre ; aucune écriture
      // des filtres ou des produits ne doit accompagner la recherche.
      assert.deepEqual(writes.filter(endpoint => !endpoint.startsWith('/telemetry/') && endpoint !== '/views/products/pills/reorder'), [])
    } finally { await ctx.close() }
  })
}
})
