// Test : la section « Chargements lents (> 500 ms) » a été retirée du
// tableau de bord système de la page /admin (signalement utilisateur).

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

async function login(page) {
  await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASS)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
}

describe('Admin — section chargements lents retirée', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await login(page)
  })

  after(async () => {
    await browser?.close()
  })

  test('le tableau de bord système ne montre plus « Chargements lents »', async () => {
    await page.goto(URL + '/admin', { waitUntil: 'networkidle' })

    // Attendre que le dashboard santé soit chargé (données /admin/health reçues)
    await page.locator('h3:has-text("Santé du serveur")').waitFor({ state: 'visible', timeout: 15000 })

    // La section retirée ne doit apparaître nulle part sur la page
    const slowSection = page.locator('text=Chargements lents')
    assert.equal(await slowSection.count(), 0, 'la section « Chargements lents » ne doit plus exister')
  })

  test('le reste du dashboard système reste fonctionnel', async () => {
    // Les autres blocs de la carte santé sont toujours rendus
    await page.locator('h2:has-text("Tableau de bord système")').waitFor({ state: 'visible', timeout: 15000 })
    const ram = page.locator('text=RAM')
    assert.ok(await ram.count() > 0, 'la jauge RAM doit toujours être affichée')
  })
})
