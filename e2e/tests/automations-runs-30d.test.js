const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe("Automations — colonne Runs (30j) remplace Résultat", () => {
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
    await page.goto(URL + '/automations', { waitUntil: 'networkidle' })
    await page.waitForSelector('h1:has-text("Automations")', { timeout: 10000 })
  })

  after(async () => { await browser?.close() })

  test("panneau Champs : Runs (30j) présent, Résultat absent", async () => {
    await page.click('button:has-text("Champs")')
    await page.waitForSelector('text=Colonnes visibles', { timeout: 3000 })

    const runsLabel = page.locator('label').filter({ hasText: /^Runs \(30j\)$/ })
    const hasRuns = await runsLabel.count()
    assert.equal(hasRuns, 1, `Runs (30j) devrait apparaître une fois, trouvé ${hasRuns}`)

    const resultatLabel = page.locator('label').filter({ hasText: /^Résultat$/ })
    const hasResultat = await resultatLabel.count()
    assert.equal(hasResultat, 0, `"Résultat" ne devrait plus exister, trouvé ${hasResultat}`)
  })
})
