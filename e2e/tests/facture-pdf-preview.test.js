const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')
const { PDFDocument } = require('../../server/node_modules/pdf-lib')

test('aperçu facture : worker .js et navigateur sans Promise.withResolvers', async () => {
  const root = path.resolve(__dirname, '../../client', process.env.ERP_TEST_BUILD || 'dist')
  const server = http.createServer((req, res) => {
    const relative = new URL(req.url, 'http://localhost').pathname.replace(/^\/erp\/?/, '')
    let file = path.resolve(root, relative)
    if (!file.startsWith(root + '/') || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html')
    // Reproduit l'ancien serveur : .mjs reste un binaire, .js est JavaScript.
    res.setHeader('Content-Type', { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream')
    fs.createReadStream(file).pipe(res)
  })
  server.on('upgrade', (_req, socket) => socket.destroy())
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const browser = await chromium.launch({ headless: true })
  try {
    const doc = await PDFDocument.create()
    doc.addPage().drawText('Facture de test : apercu PDF')
    const pdf = Buffer.from(await doc.save())
    const page = await browser.newPage()
    const workers = []
    page.on('response', response => {
      if (response.url().includes('pdf.worker')) workers.push(response)
    })
    const user = { id: 'test', name: 'Test', role: 'admin', roles: ['user', 'admin'] }
    await page.addInitScript(token => {
      localStorage.setItem('erp_token', token)
      Promise.withResolvers = undefined
    }, `test.${Buffer.from(JSON.stringify(user)).toString('base64')}.test`)
    await page.route('**/api/**', async route => {
      const endpoint = new URL(route.request().url()).pathname.replace(/^.*\/api/, '')
      if (route.request().method() !== 'GET') return route.abort()
      if (endpoint.endsWith('/pdf')) return route.fulfill({ contentType: 'application/pdf', body: pdf })
      let json = { data: [], total: 0 }
      if (endpoint === '/auth/me') json = user
      else if (endpoint === '/projets/factures/1') json = { id: '1', document_number: 'TEST-0001', currency: 'CAD', status: 'Payé', airtable_pdf_path: 'test.pdf' }
      else if (endpoint.startsWith('/custom-fields/') || endpoint.endsWith('/lookup') || endpoint.startsWith('/payments/facture/')) json = []
      else if (endpoint.startsWith('/bootstrap')) json = { tables: {}, snapshot_ts: new Date().toISOString() }
      else if (endpoint.includes('/preferences') || endpoint.startsWith('/views/')) json = {}
      await route.fulfill({ json })
    })
    await page.goto(`http://127.0.0.1:${server.address().port}/erp/factures/1`)
    const preview = page.getByTestId('facture-pdf-attachment')
    await preview.waitFor({ timeout: 10000 }).catch(async error => { console.error(await page.locator('body').innerText()); throw error })
    await page.waitForFunction(() => {
      const canvas = document.querySelector('[data-testid="facture-pdf-attachment"] canvas')
      return canvas && canvas.width > 0 && canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data.some((value, index) => index % 4 === 3 && value > 0)
    })
    assert.equal((await preview.innerText()).includes('indisponible'), false)
    assert.ok(workers.length > 0)
    for (const worker of workers) {
      assert.ok(new URL(worker.url()).pathname.endsWith('.js'))
      assert.equal(worker.headers()['content-type'], 'application/javascript')
    }
  } finally {
    await browser.close()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})
