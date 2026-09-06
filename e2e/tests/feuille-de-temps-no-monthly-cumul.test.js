const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie que la section "Cumul mensuel par code" a bien été retirée de la
// page Feuille de temps, tout en conservant le rapport RSDE en dessous.
describe('FeuilleDeTemps — section cumul mensuel retirée', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => {
    await browser?.close()
  })

  test('la section cumul mensuel par code est absente, le rapport RSDE reste', async () => {
    await page.goto(URL + '/feuille-de-temps', { waitUntil: 'domcontentloaded' })
    // Attendre que la page soit hydratée (le titre apparaît)
    await page.waitForSelector('h1:has-text("Feuille de temps")', { timeout: 10000 })
    // Le rapport RSDE doit rester en place
    await page.waitForSelector('[data-testid="rsde-report"]', { timeout: 10000 })

    // La section "Cumul mensuel par code" doit avoir disparu
    const cumulCount = await page.locator('[data-testid="monthly-cumul"]').count()
    assert.equal(cumulCount, 0, 'La section monthly-cumul ne doit plus exister')

    const cumulTitleCount = await page.getByText('Cumul mensuel par code').count()
    assert.equal(cumulTitleCount, 0, 'Le titre "Cumul mensuel par code" ne doit plus apparaître')

    // Sanity check : pas d'erreur JS bloquante
    const rsdeVisible = await page.locator('[data-testid="rsde-report"]').isVisible()
    assert.equal(rsdeVisible, true, 'Le rapport RSDE doit rester visible')
  })
})
