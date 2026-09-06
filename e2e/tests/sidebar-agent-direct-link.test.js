// Entrée « Agent » du bas de la sidebar : lien simple, sans sous-menu.
// Survoler ne doit rien déplier, et un clic doit ouvrir la page Agent.
//
// Aucun record créé ni modifié : navigation en lecture seule.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Sidebar — « Agent » mène directement à la page Agent', () => {
  let browser, ctx, page

  const agentEntry = () =>
    page.locator('[data-testid="app-sidebar"] a[href="/erp/agent"]').first()

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => {
    await browser?.close()
  })

  test('survoler « Agent » n\'ouvre aucun sous-menu', async () => {
    await page.goto(URL + '/champs/contacts', { waitUntil: 'domcontentloaded' })
    const entry = agentEntry()
    await entry.waitFor({ timeout: 15000 })
    // Chevron de sous-menu : ne doit plus être rendu sur la ligne.
    assert.equal(await entry.locator('svg').count(), 1, 'la ligne Agent porte encore un chevron de sous-menu')
    await entry.hover()
    await page.waitForTimeout(1200)
    assert.equal(
      await page.locator('[data-testid="nav-subsection-panel"][data-route="/agent"]').count(), 0,
      'un sous-menu s\'ouvre encore au survol de « Agent »',
    )
    assert.equal(
      await page.locator('[data-testid="nav-subsection-panel"]').count(), 0,
      'un panneau de sous-sections est ouvert alors qu\'aucun n\'est attendu',
    )
  })

  test('cliquer « Agent » ouvre la page Agent', async () => {
    await page.goto(URL + '/champs/contacts', { waitUntil: 'domcontentloaded' })
    const entry = agentEntry()
    await entry.waitFor({ timeout: 15000 })
    await entry.click()
    await page.waitForURL(u => u.toString().endsWith('/erp/agent'), { timeout: 15000 })
    await page.locator('h1:has-text("Agent autonome")').waitFor({ timeout: 20000 })
  })
})
