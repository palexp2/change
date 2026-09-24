const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { chromium } = require('playwright')

const source = readFileSync(require('node:path').join(__dirname, '../../client/index.html'), 'utf8')
const shell = source.replace('<script type="module" src="/src/main.jsx"></script>', '')

// Isolated browser fixtures: no server, credentials or production data.
for (const scenario of ['empty', 'wake', 'healthy', 'offline', 'cooldown', 'late-render']) {
  test(`blank tab recovery: ${scenario}`, async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      await page.clock.install({ time: new Date('2026-09-21T12:00:00Z') })
      let navigations = 0
      let probes = 0
      await page.route('**/*', async route => {
        const request = route.request()
        if (request.isNavigationRequest()) {
          navigations++
          return route.fulfill({ contentType: 'text/html', body: shell })
        }
        if (request.url() === 'https://boreal.test/erp/') {
          probes++
          if (scenario === 'offline') return route.abort()
          if (scenario === 'late-render') {
            await page.evaluate(() => { document.getElementById('root').innerHTML = '<input value="Brouillon">' })
          }
          return route.fulfill({ contentType: 'text/html', body: source })
        }
        return route.abort()
      })
      await page.goto('https://boreal.test/erp/orders?view=active#details')
      await page.evaluate(scenario => {
        localStorage.setItem('erp_token', 'session-preserved')
        if (scenario === 'wake') Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
        if (scenario === 'healthy') document.getElementById('root').innerHTML = '<input value="Brouillon">'
        if (scenario === 'cooldown') sessionStorage.setItem('boreal.blank-recovery', String(Date.now()))
      }, scenario)
      const failedProbe = scenario === 'offline'
        ? page.waitForEvent('requestfailed', request => request.url() === 'https://boreal.test/erp/')
        : null
      await page.clock.runFor(20000)
      if (failedProbe) await failedProbe
      if (scenario === 'wake') {
        assert.equal(navigations, 1, 'hidden tab stays untouched')
        assert.equal(probes, 0)
        await page.evaluate(() => {
          Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
          document.dispatchEvent(new Event('visibilitychange'))
        })
      }
      if (scenario === 'empty' || scenario === 'wake') {
        await page.waitForFunction(() => sessionStorage.getItem('boreal.blank-recovery'))
        await page.waitForLoadState('load')
        assert.equal(navigations, 2)
        await page.clock.runFor(20000)
        assert.equal(navigations, 2, 'no reload loop')
        assert.equal(await page.evaluate(() => localStorage.getItem('erp_token')), 'session-preserved')
        assert.equal(page.url(), 'https://boreal.test/erp/orders?view=active#details')
      } else {
        assert.equal(navigations, 1, 'no unnecessary reload')
        if (scenario === 'healthy' || scenario === 'late-render') {
          assert.equal(await page.locator('#root input').inputValue(), 'Brouillon')
        }
        if (scenario === 'healthy' || scenario === 'cooldown') assert.equal(probes, 0)
        if (scenario === 'offline') assert.ok(probes > 0)
      }
    } finally {
      await browser.close()
    }
  })
}
