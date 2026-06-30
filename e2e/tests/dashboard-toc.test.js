const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Table des matières du dashboard : liste sticky à gauche, un lien par section
// visible. Cliquer scrolle vers la section ; le scroll-spy surligne la section
// courante. Largeur ≥ lg requise (la TOC est masquée sous lg).
describe('Dashboard — table des matières', () => {
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
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => { await browser?.close() })

  async function topOfSection(sectionId) {
    return page.evaluate((id) => {
      const el = document.querySelector(`[data-section-id="${id}"]`)
      return el ? el.getBoundingClientRect().top : null
    }, sectionId)
  }

  test('la TOC est visible et liste au moins une section', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="dashboard-toc"]', { timeout: 15000 })
    const links = await page.locator('[data-testid="dashboard-toc"] a[data-testid^="toc-link-"]').count()
    assert.ok(links >= 1, `au moins un lien dans la TOC (got ${links})`)
  })

  test('cliquer un lien de la TOC scrolle vers la section', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="toc-link-section_balance_sheet"]', { timeout: 15000 })
    await page.click('[data-testid="toc-link-section_balance_sheet"]')
    await page.waitForTimeout(1200)
    const top = await topOfSection('section_balance_sheet')
    assert.ok(top !== null, 'section présente')
    assert.ok(top >= -50 && top < 200, `section scrollée en haut (top=${top})`)
    // L'URL reflète la section pour pouvoir la partager.
    assert.match(page.url(), /\/dashboard\/bilan$/)
  })

  test('le scroll-spy surligne le lien de la section en haut du viewport', async () => {
    await page.goto(URL + '/dashboard/bilan', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="toc-link-section_balance_sheet"]', { timeout: 15000 })
    await page.waitForTimeout(1500)
    const active = await page.getAttribute('[data-testid="toc-link-section_balance_sheet"]', 'data-active')
    assert.equal(active, 'true', 'le lien Bilan est marqué actif après scroll')
  })
})
