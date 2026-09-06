const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('RetourDetail — clic sur un item ouvre une fiche détaillée', () => {
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

  test('clic sur une ligne d\'article ouvre le modal avec les détails enrichis', async () => {
    // Navigate to retours list
    await page.goto(URL + '/retours', { waitUntil: 'networkidle' })
    await page.waitForTimeout(1500)

    // Click first retour row to open detail page
    await page.locator('text=/RMA-\\d+/').first().click()
    await page.waitForURL(/\/retours\/[a-f0-9-]+/, { timeout: 5000 })
    await page.waitForTimeout(800)

    // Verify items table is visible
    const itemRows = page.locator('table tbody tr')
    const itemCount = await itemRows.count()
    assert.ok(itemCount > 0, `aucun article trouvé sur la fiche retour, en a vu ${itemCount}`)

    // Click first item row
    await itemRows.first().click()
    await page.waitForTimeout(500)

    // Modal should be open — Modal renders into a fixed inset div with role-less; look for the title section
    const modalTitle = page.locator('h2.text-lg.font-semibold').last()
    const titleText = await modalTitle.textContent()
    assert.ok(titleText && titleText.length > 0, `modal title vide: "${titleText}"`)

    // Verify enriched sections are present (these don't appear on the parent page — they only show in the modal)
    const idSection = page.locator('text=Identification').first()
    const motifSection = page.locator('text=Motif de retour').first()
    const analyseSection = page.locator('text=Réception').first()

    assert.equal(await idSection.count(), 1, 'section Identification absente du modal')
    assert.equal(await motifSection.count(), 1, 'section Motif de retour absente du modal')
    assert.equal(await analyseSection.count(), 1, 'section Réception & analyse absente du modal')

    // Close via X button
    await page.locator('button[class*="text-slate-400"]').filter({ has: page.locator('svg') }).last().click()
    await page.waitForTimeout(400)
    const stillOpen = await page.locator('text=Identification').count()
    assert.equal(stillOpen, 0, 'modal toujours ouvert après clic sur fermeture')
  })

  test('le row d\'article a un cursor-pointer (affordance de clic)', async () => {
    const url = page.url()
    if (!/\/retours\/[a-f0-9-]+/.test(url)) {
      await page.goto(URL + '/retours', { waitUntil: 'networkidle' })
      await page.waitForTimeout(1000)
      await page.locator('text=/RMA-\\d+/').first().click()
      await page.waitForURL(/\/retours\/[a-f0-9-]+/, { timeout: 5000 })
      await page.waitForTimeout(500)
    }
    const cursor = await page.locator('table tbody tr').first().evaluate(el => getComputedStyle(el).cursor)
    assert.equal(cursor, 'pointer', `cursor attendu "pointer", reçu "${cursor}"`)
  })
})
