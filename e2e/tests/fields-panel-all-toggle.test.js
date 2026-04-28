const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('FieldsPanel — Tout voir / Tout cacher', () => {
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

  after(async () => { await browser?.close() })

  test('Tout cacher puis Tout voir alterne les colonnes affichées', async () => {
    await page.goto(URL + '/orders', { waitUntil: 'domcontentloaded' })
    // Ouvrir le panneau Champs (bouton avec texte "Champs" dans la toolbar)
    await page.locator('button', { hasText: /^Champs/ }).first().click()

    // Vérifier présence des boutons
    const allBtn = page.locator('button', { hasText: /^Tout voir$/ })
    const noneBtn = page.locator('button', { hasText: /^Tout cacher$/ })
    await allBtn.waitFor({ timeout: 5000 })
    await noneBtn.waitFor({ timeout: 5000 })

    // Cliquer Tout cacher → tous les checkboxes doivent être décochés
    await noneBtn.click()
    await page.waitForTimeout(200)
    const checkboxes = page.locator('.w-64 input[type="checkbox"]')
    const countBefore = await checkboxes.count()
    assert.ok(countBefore > 1, `attendu plusieurs checkboxes, trouvé ${countBefore}`)
    const checkedAfterHide = await checkboxes.evaluateAll(els => els.filter(e => e.checked).length)
    assert.equal(checkedAfterHide, 0, 'toutes les colonnes doivent être décochées après Tout cacher')

    // Cliquer Tout voir → tous les checkboxes doivent être cochés
    await allBtn.click()
    await page.waitForTimeout(200)
    const checkedAfterShow = await checkboxes.evaluateAll(els => els.filter(e => e.checked).length)
    assert.equal(checkedAfterShow, countBefore, 'toutes les colonnes doivent être cochées après Tout voir')
  })
})
