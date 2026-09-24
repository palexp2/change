// Navigateur sur le build local, API simulée : aucune connexion à la production.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')

describe('Produit — ajout d’un achat', () => {
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

  for (const failure of [false, true]) test(failure ? 'échec et relance sans doubler l’achat' : 'création depuis le panneau produit', async t => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    t.after(() => ctx.close())
    await ctx.routeWebSocket('**/ws**', () => {})
    const page = await ctx.newPage()
    page.setDefaultTimeout(15000)
    const errors = []
    page.on('pageerror', e => errors.push(e.message))
    const product = { id: '123', name_fr: 'Pièce test', stock_qty: 0, active: 1, movements: [] }
    const suppliers = [{ id: 'vendor-1', name: 'Principal', company_id: 'company-1' }, { id: 'vendor-2', name: 'Secondaire' }]
    const token = `test.${Buffer.from(JSON.stringify({ id: 'test', name: 'Test', role: 'admin' })).toString('base64')}.test`
    await ctx.addInitScript(token => localStorage.setItem('erp_token', token), token)
    let creates = 0, retries = 0, payload
    const purchase = { id: 'new-purchase', at_id: 'LIA-TEST', supplier_vendor_name: 'Secondaire', quantite_commande: 7 }
    await page.route('**/api/**', async route => {
      const endpoint = new URL(route.request().url()).pathname.replace(/^\/erp\/api/, '')
      if (endpoint === '/products/123') return route.fulfill({ json: product })
      if (endpoint === '/companies/lookup') return route.fulfill({ json: [] })
      if (endpoint === '/products/123/purchases/prefill') return route.fulfill({ json: { suppliers, supplier_id: 'vendor-1', quantity: 4 } })
      if (endpoint === '/products/123/purchases' && route.request().method() === 'POST') {
        creates++
        payload = route.request().postDataJSON()
        await new Promise(resolve => setTimeout(resolve, 200))
        return route.fulfill({ json: { ...purchase, airtable: failure ? { status: 'error', error: 'Indisponible' } : { status: 'success' } } })
      }
      if (endpoint === '/products/123/purchases/new-purchase/sync') {
        retries++
        return route.fulfill({ json: { ...purchase, airtable: { status: 'success' } } })
      }
      if (endpoint.startsWith('/bootstrap')) return route.fulfill({ json: { tables: {}, snapshot_ts: new Date().toISOString() } })
      if (endpoint.startsWith('/views/')) return route.fulfill({ json: { config: {}, pills: [], dynamicFields: [] } })
      if (endpoint.includes('/preferences')) return route.fulfill({ json: {} })
      return route.fulfill({ json: { data: [], total: 0 } })
    })
    await page.goto(`${base}/products/123`)
    try { await page.getByRole('button', { name: 'Ajouter un achat', exact: true }).click() } catch (error) { console.log('PAGE', page.url(), (await page.locator('body').innerText()).slice(-2500), errors); throw error }
    const modal = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Ajouter un achat' }) })
    await modal.getByLabel('Quantité', { exact: true }).waitFor()
    assert.equal(await modal.getByLabel('Quantité', { exact: true }).inputValue(), '4')
    assert.match(await page.getByTestId('product-purchase-supplier').innerText(), /Principal/)
    await modal.getByLabel('Quantité', { exact: true }).fill('0')
    assert.equal(await modal.getByRole('button', { name: 'Ajouter', exact: true }).isDisabled(), true)
    await modal.getByLabel('Quantité', { exact: true }).fill('7')
    await page.getByTestId('product-purchase-supplier').click()
    const menu = page.getByTestId('product-purchase-supplier-menu')
    await menu.locator('input').fill('Secondaire')
    await menu.getByText('Secondaire', { exact: true }).click()
    await modal.getByLabel('Note', { exact: true }).fill('Livraison groupée')
    await modal.getByRole('button', { name: 'Ajouter', exact: true }).click()
    if (failure) {
      await modal.getByRole('alert').waitFor()
      assert.match(await modal.getByRole('alert').innerText(), /Achat enregistré/)
      assert.equal(await modal.getByLabel('Note', { exact: true }).isDisabled(), true)
      await modal.getByRole('button', { name: 'Réessayer la synchronisation' }).click()
      assert.equal(retries, 1)
    }
    await modal.waitFor({ state: 'hidden' })
    assert.equal(creates, 1)
    assert.deepEqual(payload, { quantity: 7, supplier_id: 'vendor-2', notes: 'Livraison groupée' })
    assert.match(await page.locator('[data-section="achats"]').innerText(), /Secondaire/)
    assert.deepEqual(errors, [])
  })
})
