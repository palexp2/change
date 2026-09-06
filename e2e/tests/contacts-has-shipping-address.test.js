// Vérifie que GET /api/contacts expose has_shipping_address (0/1) et que
// la colonne "Adresse de livraison" est disponible dans le panel Champs.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Contacts — has_shipping_address', () => {
  let browser, ctx, page, token

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
    token = await page.evaluate(() => localStorage.getItem('erp_token'))
  })

  after(async () => { await browser?.close() })

  test('GET /api/contacts retourne has_shipping_address ∈ {0,1}', async () => {
    const resp = await page.request.get(`${URL}/api/contacts?limit=all`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(resp.status(), 200)
    const body = await resp.json()
    const yes = body.data.filter(c => c.has_shipping_address === 1)
    const no  = body.data.filter(c => c.has_shipping_address === 0)
    assert.ok(yes.length > 0, 'au moins un contact avec adresse de livraison')
    assert.ok(no.length > 0,  'au moins un contact sans')
    assert.equal(yes.length + no.length, body.data.length, 'partition stricte 0/1, pas de NULL')
  })

  test('Panel Champs liste "Adresse de livraison"', async () => {
    await page.goto(`${URL}/contacts`, { waitUntil: 'networkidle' })
    await page.locator('button:has-text("Champs")').first().click()
    await page.waitForTimeout(300)
    const bodyText = await page.locator('body').innerText()
    assert.ok(/Adresse de livraison/i.test(bodyText),
      'Le libellé "Adresse de livraison" doit apparaître dans le panel Champs')
  })
})
