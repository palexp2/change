const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Cliquer une section de la table des matières ne doit pas renvoyer le scroll
// en haut avant de redescendre : la navigation /dashboard/:section est une
// ancre dans la page, pas un changement de page (voir pageKey() dans App.jsx).
// Test en lecture seule : aucun record créé ni modifié.
describe('Dashboard — cliquer une section ne remet pas le scroll en haut', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({
      viewport: { width: 1400, height: 900 },
      timezoneId: 'America/Montreal',
    })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 20000 })
  })

  after(async () => { await browser?.close() })

  const scrollTop = () => page.evaluate(() => document.querySelector('main').scrollTop)

  test('passer de « Coûts d\'expédition » à la section suivante garde le scroll', async () => {
    await page.goto(URL + '/dashboard/couts-expedition', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="toc-link-section_geo_map"]', { timeout: 30000 })
    await page.waitForTimeout(3000)

    const start = await scrollTop()
    assert.ok(start > 500, `le deep-link a scrollé vers la section (top=${start})`)

    // Échantillonne le scroll pendant toute la transition : il ne doit jamais
    // repasser près du haut de la page.
    await page.evaluate(() => {
      const m = document.querySelector('main')
      window.__mins = []
      window.__t = setInterval(() => window.__mins.push(m.scrollTop), 25)
    })
    await page.click('[data-testid="toc-link-section_geo_map"]')
    await page.waitForTimeout(2000)
    const samples = await page.evaluate(() => {
      clearInterval(window.__t)
      // Le conteneur peut avoir été remonté : on relit celui du document.
      window.__mins.push(document.querySelector('main').scrollTop)
      return window.__mins
    })

    const min = Math.min(...samples)
    assert.ok(
      min >= start - 100,
      `le scroll n'est pas reparti d'en haut (min=${min}, départ=${start}, échantillons=${samples.length})`,
    )
    assert.match(page.url(), /\/dashboard\/carte-clients$/)
  })

  test('changer réellement de page repart bien du haut', async () => {
    await page.goto(URL + '/dashboard/couts-expedition', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="dashboard-toc"]', { timeout: 30000 })
    await page.waitForTimeout(3000)
    assert.ok(await scrollTop() > 500, 'scrollé dans le dashboard avant de naviguer')

    await page.click('a[href="/erp/envois"]')
    await page.waitForURL(/\/envois$/, { timeout: 15000 })
    await page.waitForTimeout(1500)
    assert.equal(await scrollTop(), 0, 'la nouvelle page démarre en haut')
  })
})
