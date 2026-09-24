// Build local et API simulée : aucune donnée de production modifiée.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')

describe('Contact — épinglage dans le fil', () => {
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

  async function setup(t, { type = 'note', pinned = false, fail = false, count = 3 } = {}) {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    t.after(() => ctx.close())
    const page = await ctx.newPage(), errors = [], mutations = []
    page.on('pageerror', error => { errors.push(error.message); console.error('Browser:', error.message) })
    const items = Array.from({ length: count }, (_, i) => ({
      id: `entry-${i}`, type, contact_id: 'pin-contact', pinned: pinned && i === count - 1 ? 1 : 0,
      timestamp: new Date(Date.UTC(2026, 8, 21, 12, 0, -i)).toISOString(), meeting_notes: `Contenu ${i}`,
    }))
    const token = `test.${Buffer.from(JSON.stringify({ id: 'test', name: 'Test', role: 'admin' })).toString('base64')}.test`
    await ctx.addInitScript(token => localStorage.setItem('erp_token', token), token)
    await page.route('**/api/**', async route => {
      const req = route.request(), url = new URL(req.url())
      const endpoint = url.pathname.replace(/^\/erp\/api/, '')
      if (endpoint.startsWith('/telemetry/')) return route.fulfill({ json: { ok: true } })
      if (req.method() === 'PATCH' && endpoint.endsWith('/pin')) {
        mutations.push(req.postDataJSON())
        if (fail) return route.fulfill({ status: 500, json: { error: 'Test indisponible' } })
        const item = items.find(i => endpoint === `/interactions/${i.id}/pin`)
        item.pinned = req.postDataJSON().pinned ? 1 : 0
        return route.fulfill({ json: { id: item.id, pinned: item.pinned } })
      }
      if (endpoint === '/interactions') {
        const sorted = [...items].sort((a, b) => b.pinned - a.pinned || b.timestamp.localeCompare(a.timestamp))
        const offset = Number(url.searchParams.get('offset') || 0)
        const limit = Number(url.searchParams.get('limit') || 50)
        return route.fulfill({ json: { interactions: sorted.slice(offset, offset + limit), total: items.length } })
      }
      if (endpoint === '/contacts/pin-contact') return route.fulfill({ json: { id: 'pin-contact', first_name: 'Contact', last_name: 'Test', companies: [] } })
      if (endpoint.includes('/lookup') || endpoint === '/auth/users' || endpoint.endsWith('/email-attachments')) return route.fulfill({ json: [] })
      if (endpoint.startsWith('/bootstrap')) return route.fulfill({ json: { tables: {}, snapshot_ts: new Date().toISOString() } })
      if (endpoint.includes('/preferences')) return route.fulfill({ json: {} })
      return route.fulfill({ json: { data: [], total: 0 } })
    })
    await page.goto(`${base}/contacts/pin-contact`)
    await page.getByTestId('interaction-meta').first().waitFor()
    return { page, mutations, errors }
  }

  for (const type of ['note', 'call']) test(`${type} : épingler, recharger et désépingler`, async t => {
    const { page, mutations, errors } = await setup(t, { type })
    const pin = page.getByTitle('Épingler en haut du fil').last()
    await pin.hover()
    await pin.click()
    await page.getByTitle('Désépingler', { exact: true }).waitFor()
    await page.waitForFunction(() => document.querySelector('[data-testid="interaction-meta"] button')?.title === 'Désépingler')
    assert.deepEqual(mutations, [{ pinned: true }])
    assert.equal(await page.getByText('Enregistré par', { exact: true }).count(), 0, 'épingler ne doit pas ouvrir le détail')
    await page.reload()
    await page.getByTitle('Désépingler', { exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('button[title="Désépingler"]'))
    assert.deepEqual(mutations, [{ pinned: true }, { pinned: false }])
    assert.deepEqual(errors, [])
  })

  test('désépingler une ancienne note ne saute aucune entrée entre deux pages', async t => {
    const { page, errors } = await setup(t, { pinned: true, count: 35 })
    const refreshed = page.waitForResponse(r => r.url().includes('/interactions?') && r.request().method() === 'GET')
    await page.getByTitle('Désépingler', { exact: true }).click()
    await refreshed
    await page.getByText('Contenu 29', { exact: true }).waitFor()
    await page.getByRole('button', { name: /Charger plus/ }).click()
    await page.getByText('Contenu 34', { exact: true }).waitFor()
    assert.equal(await page.getByTestId('interaction-meta').count(), 35)
    for (let i = 0; i < 35; i++) assert.equal(await page.getByText(`Contenu ${i}`, { exact: true }).count(), 1)
    assert.deepEqual(errors, [])
  })

  test('un échec conserve la note et affiche une erreur', async t => {
    const { page, mutations, errors } = await setup(t, { fail: true })
    const pin = page.getByTitle('Épingler en haut du fil').last()
    await pin.hover()
    await pin.click()
    await page.getByText("Échec de l'épinglage", { exact: true }).waitFor()
    assert.equal(await page.getByTitle('Désépingler', { exact: true }).count(), 0)
    assert.equal(await page.getByTestId('interaction-meta').count(), 3)
    assert.deepEqual(mutations, [{ pinned: true }])
    assert.deepEqual(errors, [])
  })
})
