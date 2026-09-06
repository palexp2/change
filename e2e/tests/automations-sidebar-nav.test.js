const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Automations déplacée dans le menu latéral', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => { await browser?.close() })

  test('le menu latéral (Autres outils) contient un lien Automations qui ouvre la page', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })
    // Ouvrir le groupe « Autres outils » s'il est replié
    const group = page.locator('nav button:has-text("Autres outils")')
    await group.waitFor({ state: 'visible', timeout: 10000 })
    const link = page.locator('nav a[href$="/automations"]')
    if (!(await link.isVisible().catch(() => false))) await group.click()
    await link.waitFor({ state: 'visible', timeout: 5000 })
    await link.click()
    await page.waitForURL(u => u.toString().includes('/automations'), { timeout: 10000 })
    await page.waitForSelector('h1:has-text("Automations")', { timeout: 10000 })
  })

  test("l'onglet Automations n'existe plus dans /admin", async () => {
    await page.goto(URL + '/admin', { waitUntil: 'networkidle' })
    await page.waitForSelector('h1:has-text("Paramètres")', { timeout: 10000 })
    const tab = page.locator('button:has-text("Automations")')
    assert.equal(await tab.count(), 0, "l'onglet Admin → Automations devrait avoir disparu")
  })

  test("/admin/automations redirige vers /automations", async () => {
    await page.goto(URL + '/admin/automations', { waitUntil: 'networkidle' })
    // Playwright passe un objet URL au prédicat (contexte Node)
    await page.waitForURL(u => u.pathname.endsWith('/automations'), { timeout: 10000 })
    await page.waitForSelector('h1:has-text("Automations")', { timeout: 10000 })
    const path = new (require('url').URL)(page.url()).pathname
    assert.ok(path.endsWith('/automations'), `URL attendue …/automations, obtenue ${path}`)
  })
})
