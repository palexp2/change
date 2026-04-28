const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Page Achats — pas de colonne Fournisseur doublon', () => {
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

  test('le panneau "Champs" ne liste qu\'une seule colonne "Fournisseur"', async () => {
    await page.click('button:has-text("Champs")')
    await page.waitForSelector('text=Colonnes visibles', { timeout: 3000 })

    // Compter les labels exacts "Fournisseur" (pas "Fournisseur - LEGACY" ni "Fournisseur préféré")
    const labels = page.locator('label').filter({ hasText: /^Fournisseur$/ })
    const count = await labels.count()
    assert.equal(count, 1, `attendu 1 colonne "Fournisseur", trouvé ${count}`)
  })
})
