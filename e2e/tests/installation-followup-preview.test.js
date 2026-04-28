const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe("sys_installation_followup — aperçu basé sur un vrai record", () => {
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
    await page.goto(URL + '/automations/sys_installation_followup', { waitUntil: 'networkidle' })
    await page.waitForSelector('text=Aperçu du courriel', { timeout: 10000 })
  })

  after(async () => { await browser?.close() })

  test("l'étiquette « Rendu à partir du record » apparaît", async () => {
    const label = page.locator('text=/Rendu à partir du record/')
    await label.waitFor({ state: 'visible', timeout: 5000 })
    const txt = (await label.textContent() || '').trim()
    assert.ok(/Rendu à partir du record/.test(txt), `texte inattendu: ${txt}`)

    // Un <code> avec le nom du record doit suivre
    const codeEl = page.locator('p', { hasText: /Rendu à partir du record/ }).locator('code').first()
    const codeTxt = (await codeEl.textContent() || '').trim()
    assert.ok(codeTxt.length > 0, 'nom du record vide dans <code>')
    assert.notEqual(codeTxt, '00000000-0000-0000-0000-000000000000', 'encore le placeholder UUID')
  })
})
