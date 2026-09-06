const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('PO — nom de produit sans SKU', () => {
  let browser, ctx, page, product

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    product = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const res = await fetch('/erp/api/products?limit=all', { headers: { Authorization: `Bearer ${token}` } })
      const data = await res.json()
      const list = data.data || data
      // Un produit avec SKU ET (manufacturier ou name_fr) pour vérifier qu'on n'inclut pas le SKU.
      const p = list.find(x => x.buy_via_po && x.sku && (x.manufacturier || x.name_fr))
      return p || null
    })
    assert.ok(product, 'aucun produit buy_via_po avec SKU et manufacturier/name_fr trouvé')
  })

  after(async () => { await browser?.close() })

  test('prefill ne contient pas le SKU dans le nom du produit', async () => {
    const prefill = await page.evaluate(async (id) => {
      const token = localStorage.getItem('erp_token')
      const res = await fetch(`/erp/api/products/${id}/purchase-order/prefill`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      return res.json()
    }, product.id)

    assert.ok(prefill.items && prefill.items.length > 0, 'items[] attendu')
    const name = prefill.items[0].product
    const expected = product.manufacturier || product.name_fr
    assert.strictEqual(name, expected,
      `Nom attendu "${expected}" (manufacturier ou name_fr), reçu "${name}"`)
    assert.ok(!name.includes(product.sku),
      `Le SKU "${product.sku}" ne doit pas apparaître dans le nom "${name}"`)
  })
})
