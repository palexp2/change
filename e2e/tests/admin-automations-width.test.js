const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe("Admin → Automations : largeur alignée sur les autres tableaux", () => {
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

  test("largeur DataTable Admin/Automations ~= largeur DataTable /purchases", async () => {
    // Purchases page (référence : max-w-7xl = 1280px)
    await page.goto(URL + '/purchases', { waitUntil: 'networkidle' })
    await page.waitForSelector('h1:has-text("Achats")', { timeout: 10000 })
    const refCard = page.locator('.card').first()
    await refCard.waitFor({ state: 'visible', timeout: 5000 })
    const refBox = await refCard.boundingBox()
    assert.ok(refBox, 'Purchases: card non visible')

    // Admin → Automations
    await page.goto(URL + '/admin', { waitUntil: 'networkidle' })
    await page.click('button:has-text("Automations")')
    await page.waitForTimeout(400)
    const autoCard = page.locator('.card').first()
    await autoCard.waitFor({ state: 'visible', timeout: 5000 })
    const autoBox = await autoCard.boundingBox()
    assert.ok(autoBox, 'Automations: card non visible')

    // Tolérance de 20px pour gutters/scrollbar
    const diff = Math.abs(refBox.width - autoBox.width)
    assert.ok(diff <= 20, `largeurs très différentes: purchases=${refBox.width}, automations=${autoBox.width}, diff=${diff}`)
  })
})
