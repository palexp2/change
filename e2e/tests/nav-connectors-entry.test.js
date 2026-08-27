const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Connecteurs joignable depuis le menu latéral', () => {
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

  test('le menu latéral (Autres outils) contient un lien Connecteurs qui ouvre la page', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })
    const group = page.locator('nav button:has-text("Autres outils")')
    await group.waitFor({ state: 'visible', timeout: 10000 })
    const link = page.locator('nav a[href$="/connectors"]')
    if (!(await link.isVisible().catch(() => false))) await group.click()
    await link.waitFor({ state: 'visible', timeout: 5000 })
    await link.click()
    await page.waitForURL(u => u.pathname.endsWith('/connectors'), { timeout: 10000 })
    // La page Connecteurs affiche la carte Gmail
    await page.locator('button:has-text("Gmail")').first().waitFor({ state: 'visible', timeout: 10000 })
  })

  test('la palette ⌘K trouve « Connecteurs » et y navigue', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })
    await page.click('[data-testid="sidebar-search"]')
    const input = page.locator('[data-testid="global-search-input"]')
    await input.waitFor({ state: 'visible', timeout: 5000 })
    await input.fill('connecteurs')
    // Résultat de la palette, pas le lien de la sidebar (masqué par l'overlay)
    const result = page.locator('[data-testid="global-search-page-/connectors"]')
    await result.waitFor({ state: 'visible', timeout: 5000 })
    await result.click()
    await page.waitForURL(u => u.pathname.endsWith('/connectors'), { timeout: 10000 })
  })

  test('depuis Connecteurs, le toggle « Corbeille après import » du compte Gmail est atteignable', async () => {
    await page.goto(URL + '/connectors', { waitUntil: 'networkidle' })
    await page.locator('button:has-text("Gmail")').first().click()
    const label = page.locator('label:has-text("Corbeille après import")').first()
    await label.waitFor({ state: 'visible', timeout: 5000 })
    assert.ok(await label.isVisible(), 'toggle « Corbeille après import » introuvable')
    // Lecture seule : aucun clic, donc aucune config à restaurer.
  })
})
