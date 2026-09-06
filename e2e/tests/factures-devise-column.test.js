const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Factures — colonne Devise', () => {
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

  test("L'API factures retourne bien la devise pour chaque ligne", async () => {
    await page.goto(URL + '/factures', { waitUntil: 'domcontentloaded' })
    const rows = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/projets/factures?limit=all', {
        headers: { Authorization: `Bearer ${token}` },
      })
      return r.json()
    })
    assert.ok(Array.isArray(rows.data), 'réponse doit contenir data[]')
    const withCurrency = rows.data.filter(f => f.currency)
    assert.ok(
      withCurrency.length > 100,
      `au moins 100 factures doivent avoir une devise (trouvé ${withCurrency.length}/${rows.data.length})`,
    )
    const unique = new Set(withCurrency.map(f => f.currency))
    assert.ok(unique.has('CAD') || unique.has('USD'), `devises attendues (CAD/USD) introuvables — trouvé ${[...unique].join(', ')}`)
  })

  test("La colonne 'Devise' s'affiche dans la vue 'Toutes les factures' avec les valeurs CAD/USD", async () => {
    await page.goto(URL + '/factures', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=Factures clients', { timeout: 10000 })
    await page.waitForTimeout(1000)

    // Forcer la vue par défaut "Toutes les factures" (sans pill actif)
    const allTab = page.locator('button', { hasText: /^Toutes les factures$/ }).first()
    if (await allTab.count()) {
      await allTab.click()
      await page.waitForTimeout(800)
    }

    // L'en-tête "Devise" doit être visible
    const deviseHeader = page.locator('div', { hasText: /^Devise$/ }).first()
    await deviseHeader.waitFor({ state: 'visible', timeout: 5000 })

    // Au moins une cellule doit afficher "CAD" ou "USD" (valeurs de devise)
    const cadCount = await page.locator('.font-mono:has-text("CAD")').count()
    const usdCount = await page.locator('.font-mono:has-text("USD")').count()
    assert.ok(
      cadCount + usdCount > 0,
      `au moins une cellule Devise doit être rendue avec CAD ou USD (CAD: ${cadCount}, USD: ${usdCount})`,
    )
  })
})
