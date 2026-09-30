// Navigateur sur le build local, API simulée : aucune connexion à la production.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')

describe('Accueil téléphone — capture de facture', () => {
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


  async function open(t, { phone = true, landscape = false, loggedIn = true, pap = false, denied = false } = {}) {
    const ctx = await browser.newContext({
      viewport: phone ? (landscape ? { width: 844, height: 390 } : { width: 390, height: 844 }) : { width: 1440, height: 900 },
      isMobile: phone, hasTouch: phone,
    })
    t.after(() => ctx.close())
    await ctx.routeWebSocket('**/ws**', () => {})
    const user = { id: pap ? '5637ebf2-74e8-4245-9f1e-64d80b53b216' : 'test', name: 'Test', role: 'admin' }
    const token = `test.${Buffer.from(JSON.stringify(user)).toString('base64')}.test`
    await ctx.addInitScript(({ token, loggedIn, denied }) => {
      if (loggedIn) localStorage.setItem('erp_token', token)
      window.cameraRequests = []
      window.cameraStreams = []
      navigator.mediaDevices.getUserMedia = async constraints => {
        window.cameraRequests.push(constraints)
        if (denied) throw new DOMException('Denied', 'NotAllowedError')
        const canvas = document.createElement('canvas')
        canvas.width = 640; canvas.height = 480
        const ctx = canvas.getContext('2d')
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 640, 480)
        const stream = canvas.captureStream(10)
        window.cameraStreams.push(stream)
        return stream
      }
    }, { token, loggedIn, denied })
    await ctx.route('**/api/**', async route => {
      const endpoint = new URL(route.request().url()).pathname.replace(/^\/erp\/api/, '')
      if (endpoint === '/auth/login') return route.fulfill({ json: { user, token } })
      if (endpoint === '/auth/me') return route.fulfill({ json: user })
      if (endpoint.startsWith('/bootstrap')) return route.fulfill({ json: { tables: {}, snapshot_ts: new Date().toISOString() } })
      if (endpoint.startsWith('/views/')) return route.fulfill({ json: { config: {}, pills: [], dynamicFields: [] } })
      if (endpoint.includes('/preferences')) return route.fulfill({ json: {} })
      return route.fulfill({ json: { data: [], total: 0 } })
    })
    const page = await ctx.newPage()
    page.setDefaultTimeout(10000)
    return page
  }

  for (const landscape of [false, true]) test(`Accueil connecté, téléphone ${landscape ? 'paysage' : 'portrait'}`, async t => {
    const page = await open(t, { landscape, pap: true })
    await page.goto(base + '/')
    await page.getByTestId('webcam-video').waitFor({ state: 'visible' })
    await page.waitForURL(base + '/sale-receipts')
    await page.waitForFunction(() => document.querySelector('video')?.videoWidth > 0)
    assert.equal(await page.evaluate(() => window.cameraRequests[0].video.facingMode.ideal), 'environment')
    await page.getByTestId('webcam-capture').click()
    await page.getByTestId('webcam-preview').waitFor({ state: 'visible' })
    await page.locator('[data-modal-close]').click()
    await page.getByTestId('webcam-preview').waitFor({ state: 'detached' })
    assert.ok(await page.evaluate(() => window.cameraStreams.every(s => s.getTracks().every(t => t.readyState === 'ended'))))
    await page.reload()
    await page.getByTestId('open-webcam').waitFor()
    assert.equal(await page.getByTestId('webcam-video').count(), 0)
    assert.equal(await page.evaluate(() => window.cameraRequests.length), 0)
  })

  test('Connexion sur téléphone puis ouverture automatique', async t => {
    const page = await open(t, { loggedIn: false })
    await page.goto(base + '/')
    await page.waitForURL(base + '/login')
    assert.equal(await page.evaluate(() => window.cameraRequests.length), 0)
    await page.fill('input[type="email"]', 'test@example.com')
    await page.fill('input[type="password"]', 'test')
    await page.getByRole('button', { name: 'Se connecter' }).click()
    await page.getByTestId('webcam-video').waitFor()
    await page.waitForURL(base + '/sale-receipts')
  })

  for (const pap of [false, true]) test(`Accueil ordinateur ${pap ? 'personnalisé' : 'standard'}`, async t => {
    const page = await open(t, { phone: false, pap })
    await page.goto(base + '/')
    await page.waitForURL(base + (pap ? '/travaux' : '/dashboard'))
    assert.equal(await page.evaluate(() => window.cameraRequests.length), 0)
  })

  test('Lien direct et navigation sur téléphone préservés', async t => {
    const page = await open(t)
    await page.goto(base + '/sale-receipts')
    await page.getByTestId('open-webcam').waitFor()
    assert.equal(await page.getByTestId('webcam-video').count(), 0)
    await page.goto(base + '/dashboard/ventes')
    await page.waitForURL(base + '/dashboard/ventes')
    assert.equal(await page.evaluate(() => window.cameraRequests.length), 0)
  })

  async function background(page, hidden) {
    await page.evaluate(hidden => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: hidden ? 'hidden' : 'visible' })
      document.dispatchEvent(new Event('visibilitychange'))
    }, hidden)
  }

  for (const path of ['/travaux', '/dashboard']) test(`Ancien raccourci ${path}, ouvert deux fois`, async t => {
    const page = await open(t, { pap: true })
    for (let i = 0; i < 2; i++) {
      await page.goto(base + path)
      await page.getByTestId('webcam-video').waitFor()
      await page.waitForURL(base + '/sale-receipts')
      await page.locator('[data-modal-close]').click()
    }
  })

  test('Travaux reste accessible par le menu ; chaque retour rouvre la caméra', async t => {
    const page = await open(t, { pap: true })
    await page.goto(base + '/')
    await page.getByTestId('webcam-video').waitFor()
    await page.locator('[data-modal-close]').click()
    for (let i = 0; i < 2; i++) {
      // Le bouton commun du rail utilise la navigation React, sans recharger l'app.
      await page.getByTestId('ai-usage').first().evaluate(el => el.click())
      await page.waitForURL(base + '/travaux')
      assert.equal(await page.getByTestId('webcam-video').count(), 0)
      await background(page, true)
      await background(page, false)
      await page.getByTestId('webcam-video').waitFor()
      await page.locator('[data-modal-close]').click()
    }
  })

  test('Retour sur la liste des reçus et restauration du navigateur', async t => {
    const page = await open(t)
    await page.goto(base + '/sale-receipts')
    await page.getByTestId('open-webcam').waitFor()
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })))
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
    await page.getByTestId('webcam-video').waitFor()
    await page.locator('[data-modal-close]').click()
    // Le deuxième signal d'une même reprise ne doit pas rouvrir la fenêtre.
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
    assert.equal(await page.getByTestId('webcam-video').count(), 0)
  })

  test('Une photo en cours reste intacte au retour', async t => {
    const page = await open(t)
    await page.goto(base + '/')
    await page.waitForFunction(() => document.querySelector('video')?.videoWidth > 0)
    await page.getByTestId('webcam-capture').click()
    const preview = page.getByTestId('webcam-preview')
    await preview.waitFor()
    const photo = await preview.getAttribute('src')
    const requests = await page.evaluate(() => window.cameraRequests.length)
    await background(page, true)
    await background(page, false)
    assert.equal(await preview.getAttribute('src'), photo)
    assert.equal(await page.evaluate(() => window.cameraRequests.length), requests)
  })

  test('Une saisie et les liens précis sont préservés à la reprise', async t => {
    const page = await open(t)
    await page.goto(base + '/sale-receipts')
    await page.getByTestId('open-webcam').waitFor()
    await page.evaluate(() => {
      const input = document.createElement('textarea')
      input.id = 'test-draft'; input.value = 'Saisie en cours'
      document.body.append(input); input.focus()
    })
    await background(page, true)
    await background(page, false)
    assert.equal(await page.locator('#test-draft').inputValue(), 'Saisie en cours')
    assert.equal(await page.getByTestId('webcam-video').count(), 0)
    await page.goto(base + '/dashboard/ventes')
    await background(page, true)
    await background(page, false)
    assert.equal(new URL(page.url()).pathname, '/erp/dashboard/ventes')
  })

  test('La reprise sur ordinateur ne redirige pas vers la caméra', async t => {
    const page = await open(t, { phone: false, pap: true })
    await page.goto(base + '/travaux')
    await page.waitForURL(base + '/travaux')
    await background(page, true)
    await background(page, false)
    assert.equal(new URL(page.url()).pathname, '/erp/travaux')
    assert.equal(await page.evaluate(() => window.cameraRequests.length), 0)
  })

  test('Refus de caméra : message et fermeture possibles', async t => {
    const page = await open(t, { denied: true })
    await page.goto(base + '/')
    await page.getByText('Permission refusée.', { exact: false }).waitFor()
    await page.getByText('Fermer', { exact: true }).click()
    await page.getByText('Permission refusée.', { exact: false }).waitFor({ state: 'detached' })
    await page.getByTestId('open-webcam').waitFor()
    assert.equal(new URL(page.url()).search, '')
  })
})
