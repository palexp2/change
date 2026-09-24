const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { chromium } = require('playwright')

const script = fs.readFileSync(path.resolve(__dirname, '../../client/src/lib/recoverStaleModule.js'), 'utf8')
const shell = `<div id="root">Fiche commande</div><script>${script}</script>`
for (const scenario of ['recovery', 'offline', 'bad-response', 'storage-blocked']) {
  test(`module indisponible : ${scenario}`, async () => {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      let navigations = 0
      await page.route('**/*', route => {
        if (route.request().isNavigationRequest()) {
          navigations++
          return route.fulfill({ contentType: 'text/html', body: shell })
        }
        if (scenario === 'offline') return route.abort()
        return route.fulfill({ contentType: 'text/html', body: scenario === 'bad-response' ? 'indisponible' : '<div id="root"></div><script type="module"></script>' })
      })
      await page.goto('https://boreal.test/erp/adresses/1?view=active#details')
      await page.evaluate(scenario => {
        localStorage.setItem('erp_token', 'session-preserved')
        if (scenario === 'storage-blocked') Storage.prototype.setItem = () => { throw new Error('Blocked') }
        window.dispatchEvent(new Event('vite:preloadError'))
      }, scenario)
      if (scenario === 'recovery') {
        await page.waitForFunction(() => sessionStorage.getItem('boreal.module-recovery'))
        await page.waitForLoadState('load')
        assert.equal(navigations, 2)
        assert.equal(await page.evaluate(() => localStorage.getItem('erp_token')), 'session-preserved')
        assert.equal(page.url(), 'https://boreal.test/erp/adresses/1?view=active#details')
        await page.evaluate(() => window.dispatchEvent(new Event('vite:preloadError')))
      }
      await page.waitForTimeout(300)
      assert.equal(navigations, scenario === 'recovery' ? 2 : 1, 'pas de boucle de rechargement')
    } finally { await browser.close() }
  })
}

test('builds successifs : conserver les modules récents et leurs dates, retirer les anciens', async () => {
  const { retainRecentAssets } = await import('../../client/vite.config.js')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-assets-'))
  try {
    const dir = path.join(root, 'dist/assets')
    fs.mkdirSync(dir, { recursive: true })
    const recent = new Date(Date.now() - 86400000)
    const old = new Date(Date.now() - 8 * 86400000)
    for (const [name, date] of [['recent.js', recent], ['expired.js', old]]) {
      fs.writeFileSync(path.join(dir, name), name)
      fs.utimesSync(path.join(dir, name), date, date)
    }
    let plugin = retainRecentAssets()
    plugin.configResolved({ root, build: { outDir: '.dist-build' } })
    plugin.writeBundle()
    assert.equal(fs.readFileSync(path.join(root, '.dist-build/assets/recent.js'), 'utf8'), 'recent.js')
    assert.ok(!fs.existsSync(path.join(root, '.dist-build/assets/expired.js')))
    fs.rmSync(path.join(root, 'dist'), { recursive: true })
    fs.renameSync(path.join(root, '.dist-build'), path.join(root, 'dist'))
    plugin = retainRecentAssets()
    plugin.configResolved({ root, build: { outDir: 'dist' } })
    fs.rmSync(path.join(root, 'dist'), { recursive: true })
    plugin.writeBundle()
    assert.ok(Math.abs(fs.statSync(path.join(dir, 'recent.js')).mtimeMs - recent.getTime()) < 1)
    plugin = retainRecentAssets()
    plugin.configResolved({ root, build: { outDir: 'dist' } })
    fs.writeFileSync(path.join(dir, 'recent.js'), 'new build')
    plugin.writeBundle()
    assert.equal(fs.readFileSync(path.join(dir, 'recent.js'), 'utf8'), 'new build')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
