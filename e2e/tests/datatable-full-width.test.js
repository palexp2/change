const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('DataTable — pleine largeur de page sur les listes standards', () => {
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

  // À 1600px de viewport, la sidebar fait ~224px, donc le main fait ~1376px.
  // Avant le changement, max-w-7xl plafonnait la card à 1280px - 48px (padding) = 1232px.
  // Après le changement, on attend une card qui occupe la quasi-totalité de l'espace
  // disponible (≥ 1300px à ce viewport).
  for (const path of ['/orders', '/factures', '/companies', '/contacts', '/products', '/tasks', '/purchases']) {
    test(`${path} : la card du DataTable s'étend en pleine largeur`, async () => {
      await page.goto(URL + path, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(600)
      const card = page.locator('main .card').first()
      await card.waitFor({ state: 'visible', timeout: 10000 })
      const box = await card.boundingBox()
      assert.ok(box, `${path}: card non visible`)
      assert.ok(
        box.width >= 1300,
        `${path}: card.width=${box.width} (attendu ≥ 1300px sur viewport 1600 — max-w-7xl encore présent ?)`
      )
    })
  }
})
