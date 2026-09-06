const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie que les liens "Contacts" et "Entreprises" sont visibles dans le
// groupe Clients de la sidebar et qu'ils naviguent vers les bonnes pages.
describe('Sidebar — Clients : Contacts & Entreprises', () => {
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
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })
  })

  after(async () => { await browser?.close() })

  test('le groupe Clients contient Contacts et Entreprises et navigue', async () => {
    // Ouvrir le groupe Clients s'il est replié
    const clientsGroup = page.locator('button:has-text("Clients")').first()
    await clientsGroup.waitFor({ state: 'visible', timeout: 5000 })
    const expanded = await clientsGroup.getAttribute('aria-expanded')
    if (expanded === 'false') await clientsGroup.click()

    // Les deux liens doivent être visibles
    const contactsLink = page.locator('a[href$="/contacts"]').first()
    const companiesLink = page.locator('a[href$="/companies"]').first()
    await contactsLink.waitFor({ state: 'visible', timeout: 3000 })
    await companiesLink.waitFor({ state: 'visible', timeout: 3000 })

    // Labels attendus
    assert.match(await contactsLink.textContent() || '', /Contacts/)
    assert.match(await companiesLink.textContent() || '', /Entreprises/)

    // Navigation Contacts
    await contactsLink.click()
    await page.waitForURL(u => u.toString().endsWith('/contacts'), { timeout: 5000 })

    // Navigation Entreprises (rouvrir le groupe si la nav l'a refermé)
    const clientsGroup2 = page.locator('button:has-text("Clients")').first()
    if ((await clientsGroup2.getAttribute('aria-expanded')) === 'false') {
      await clientsGroup2.click()
    }
    await companiesLink.click()
    await page.waitForURL(u => u.toString().endsWith('/companies'), { timeout: 5000 })
  })
})
