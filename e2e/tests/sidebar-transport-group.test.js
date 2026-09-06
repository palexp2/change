// Sidebar — la section qui regroupe Commandes / Envois / Retours s'appelle
// « Transport » (auparavant « Envois », qui doublonnait avec la page du même
// nom qu'elle contient).
//
// Test 100 % lecture : navigation et clic de dépliage seulement, aucune donnée
// créée, modifiée ni supprimée. L'état de dépliage vit dans le localStorage du
// profil navigateur jetable du test.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Sidebar — section « Transport »', () => {
  let browser, ctx, page

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

  test('la section s\'appelle Transport et plus « Envois »', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'domcontentloaded' })
    const sidebar = page.locator('[data-testid="app-sidebar"]')
    await sidebar.waitFor({ state: 'visible', timeout: 15000 })

    assert.equal(await sidebar.locator('nav button:has-text("Transport")').count(), 1,
      'bouton de section « Transport » absent de la sidebar')
    assert.equal(await sidebar.locator('nav button:has-text("Envois")').count(), 0,
      'une section « Envois » subsiste dans la sidebar')
  })

  test('la section Transport contient toujours Commandes, Envois et Retours', async () => {
    const sidebar = page.locator('[data-testid="app-sidebar"]')
    const groupBtn = sidebar.locator('nav button:has-text("Transport")')
    if ((await groupBtn.getAttribute('aria-expanded')) !== 'true') await groupBtn.click()
    await sidebar.locator('a[href$="/erp/envois"]').waitFor({ state: 'visible', timeout: 5000 })

    for (const href of ['/erp/orders', '/erp/envois', '/erp/retours']) {
      assert.ok(await sidebar.locator(`a[href$="${href}"]`).count() >= 1, `lien absent sous Transport : ${href}`)
    }
    // Le sous-item conserve son nom : c'est la section qui a été renommée.
    assert.ok(await sidebar.locator('a[href$="/erp/envois"]:has-text("Envois")').count() >= 1,
      'le lien « Envois » a perdu son libellé')
  })

  test('la page Envois reste joignable depuis la section Transport', async () => {
    const sidebar = page.locator('[data-testid="app-sidebar"]')
    await sidebar.locator('a[href$="/erp/envois"]').first().click()
    await page.waitForURL(u => u.toString().includes('/envois'), { timeout: 15000 })
    await page.locator('h1:has-text("Envois")').waitFor({ state: 'visible', timeout: 15000 })
  })
})
