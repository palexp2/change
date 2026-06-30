const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Test lecture seule : ne crée ni ne modifie aucun record (pas de cleanup requis).
describe('Assemblages — product_name cliquable vers /products/:id', () => {
  let browser, ctx, page, sample

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    // Vérifie que le payload de l'API expose bien product_id (nécessaire au Link).
    sample = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const res = await fetch('/erp/api/projets/assemblages?limit=50', { headers: { Authorization: `Bearer ${token}` } })
      const data = await res.json()
      const list = data.data || data
      const a = list.find(x => x.product_id && x.product_name)
      return a || null
    })
    assert.ok(sample, 'aucun assemblage avec product_id + product_name trouvé')
  })

  after(async () => { await browser?.close() })

  test('le nom du produit est un lien <a> vers /products/:id', async () => {
    await page.goto(URL + '/assemblages', { waitUntil: 'domcontentloaded' })
    // Attend qu'au moins un lien produit soit rendu dans le tableau.
    const link = page.locator('a[href*="/products/"]').first()
    await link.waitFor({ state: 'visible', timeout: 15000 })

    const href = await link.getAttribute('href')
    assert.match(href, /\/products\/\S+$/, `href produit attendu, reçu "${href}"`)

    // Clique et confirme la navigation vers la fiche produit.
    await link.click()
    await page.waitForURL(u => /\/products\/\S+/.test(u.toString()), { timeout: 10000 })
    assert.match(page.url(), /\/products\/\S+/, `URL fiche produit attendue, reçu "${page.url()}"`)
  })
})
