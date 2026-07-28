const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS || 'saluerlessoviets'

describe('Paies — bouton « Sync Airtable » aligné sur les autres pages', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => { await browser?.close() })

  test('le bouton scindé « paies-airtable-sync » a disparu', async () => {
    await page.goto(URL + '/paies', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="paies-airtable-map-open"]', { timeout: 15000 })
    const oldBtn = await page.locator('[data-testid="paies-airtable-sync"]').count()
    assert.equal(oldBtn, 0, "l'ancien segment d'import immédiat ne doit plus exister")
  })

  test('un unique bouton « Sync Airtable » ouvre la modale de mapping', async () => {
    const btn = page.locator('[data-testid="paies-airtable-map-open"]')
    await assert.doesNotReject(btn.waitFor({ timeout: 10000 }))

    // Même design que les autres pages : libellé « Sync Airtable » porté par le
    // bouton qui ouvre la modale de mapping (pas de segment d'import séparé).
    const label = (await btn.innerText()).trim()
    assert.equal(label, 'Sync Airtable', `libellé attendu « Sync Airtable » (obtenu « ${label} »)`)

    // Ouvre la modale de mapping (onglets Paies + Items de paie)
    await btn.click()
    await page.waitForSelector('[role="dialog"] [data-testid="coremap-tab-paies"]', { timeout: 10000 })
    const tabs = await page.locator('[role="dialog"] [data-testid^="coremap-tab-"]').count()
    assert.ok(tabs >= 2, `au moins 2 onglets de mapping attendus (obtenu ${tabs})`)
  })
})
