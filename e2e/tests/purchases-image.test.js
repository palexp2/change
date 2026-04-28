const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Page Achats — colonne Image', () => {
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
    await page.goto(URL + '/purchases', { waitUntil: 'networkidle' })
    await page.waitForSelector('h1:has-text("Achats")', { timeout: 10000 })
  })

  after(async () => { await browser?.close() })

  test('la colonne Image rend bien des vignettes <img> (image du produit lié)', async () => {
    // Open Champs panel
    await page.click('button:has-text("Champs")')
    await page.waitForSelector('text=Colonnes visibles', { timeout: 3000 })

    // Find the "Image" row checkbox and ensure it's checked
    const imgLabel = page.locator('label', { hasText: /^Image$/ }).first()
    await imgLabel.waitFor({ state: 'visible', timeout: 3000 })
    const cb = imgLabel.locator('input[type="checkbox"]')
    if (!(await cb.isChecked())) {
      await cb.check()
    }

    // Close panel
    await page.keyboard.press('Escape')
    await page.mouse.click(50, 300)
    await page.waitForTimeout(500)

    // Verify <img> tags pointing to product-images appear in the table
    const productImgs = page.locator('img[src*="/api/product-images/"]')
    await productImgs.first().waitFor({ state: 'visible', timeout: 5000 })
    const count = await productImgs.count()
    assert.ok(count > 0, `aucune vignette product-images rendue (count=${count})`)

    // Verify size is reasonable (not text masquerading as img)
    const box = await productImgs.first().boundingBox()
    assert.ok(box && box.width >= 30 && box.height >= 30, `vignette trop petite: ${JSON.stringify(box)}`)
  })
})
