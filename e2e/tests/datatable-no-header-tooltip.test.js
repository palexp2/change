// Vérifie que les headers de colonnes des DataTable n'ont plus le tooltip
// « Clic-droit pour grouper, filtrer, trier ou cacher » (attribut title retiré).
// Test read-only : aucune donnée créée ni modifiée.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('DataTable — pas de tooltip sur les headers de colonnes', () => {
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

  for (const path of ['/factures', '/contacts']) {
    test(`aucun header de colonne avec un title sur ${path}`, async () => {
      await page.goto(URL + path, { waitUntil: 'domcontentloaded' })
      // Attendre que le DataTable ait rendu ses headers (cellules draggable)
      await page.waitForSelector('div[draggable="true"]', { timeout: 15000 })
      const headers = page.locator('div[draggable="true"]')
      const count = await headers.count()
      assert.ok(count > 0, 'au moins un header de colonne attendu')
      // Aucun header ne doit porter l'ancien tooltip (ni aucun attribut title)
      const withTitle = await page.locator('div[draggable="true"][title]').count()
      assert.equal(withTitle, 0, `${withTitle} header(s) portent encore un attribut title`)
      const oldTooltip = await page
        .locator('[title="Clic-droit pour grouper, filtrer, trier ou cacher"]').count()
      assert.equal(oldTooltip, 0, 'l’ancien tooltip est encore présent dans le DOM')
    })
  }
})
