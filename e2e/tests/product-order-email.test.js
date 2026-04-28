const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Produit — courriel pour commande', () => {
  let browser, ctx, page, productId, originalOrderEmail

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    const picked = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const res = await fetch('/erp/api/products?limit=all', { headers: { Authorization: `Bearer ${token}` } })
      const data = await res.json()
      const list = data.data || data
      const p = list.find(x => x.buy_via_po && x.supplier_company_id)
      return { id: p?.id || null, order_email: p?.order_email || null, product: p || null }
    })
    productId = picked.id
    originalOrderEmail = picked.order_email
    assert.ok(productId, 'aucun produit buy_via_po avec fournisseur trouvé')
  })

  after(async () => {
    if (productId) {
      // Restore original value
      await page.evaluate(async ({ id, email }) => {
        const token = localStorage.getItem('erp_token')
        const prod = await fetch(`/erp/api/products/${id}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
        await fetch(`/erp/api/products/${id}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...prod, order_email: email || null }),
        })
      }, { id: productId, email: originalOrderEmail })
    }
    await browser?.close()
  })

  test('PUT /products/:id accepte order_email et la lit au GET', async () => {
    const result = await page.evaluate(async (id) => {
      const token = localStorage.getItem('erp_token')
      const prod = await fetch(`/erp/api/products/${id}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
      const put = await fetch(`/erp/api/products/${id}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...prod, order_email: 'commandes@fournisseur-test.com' }),
      })
      const putBody = await put.json()
      const refetch = await fetch(`/erp/api/products/${id}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
      return { putStatus: put.status, putBody, refetch }
    }, productId)
    assert.strictEqual(result.putStatus, 200)
    assert.strictEqual(result.putBody.order_email, 'commandes@fournisseur-test.com')
    assert.strictEqual(result.refetch.order_email, 'commandes@fournisseur-test.com')
  })

  test('poPrefill retourne order_email comme supplier_email par défaut', async () => {
    const prefill = await page.evaluate(async (id) => {
      const token = localStorage.getItem('erp_token')
      const res = await fetch(`/erp/api/products/${id}/purchase-order/prefill`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      return res.json()
    }, productId)
    assert.strictEqual(prefill.supplier_email, 'commandes@fournisseur-test.com',
      'supplier_email doit prendre la valeur de order_email quand renseigné')
  })

  test('ProductDetail UI affiche le champ "Courriel pour commande"', async () => {
    await page.goto(`${URL}/products/${productId}`, { waitUntil: 'networkidle' })
    const label = page.locator('label:has-text("Courriel pour commande")')
    await label.waitFor({ state: 'visible', timeout: 5000 })
    const input = page.locator('label:has-text("Courriel pour commande") + input').first()
    const value = await input.inputValue()
    assert.strictEqual(value, 'commandes@fournisseur-test.com')
  })

  test('PO modal utilise order_email comme destinataire par défaut', async () => {
    await page.goto(`${URL}/products/${productId}`, { waitUntil: 'networkidle' })
    await page.waitForSelector('button:has-text("Générer un PO")', { timeout: 10000 })
    await page.click('button:has-text("Générer un PO")')
    await page.waitForSelector('button:has-text("Envoyer au fournisseur")', { timeout: 10000 })
    await page.click('button:has-text("Envoyer au fournisseur")')

    await page.waitForSelector('label:has-text("Destinataire")', { timeout: 5000 })
    // Le destinataire peut être un select (si order_email matche un contact) ou un input (sinon).
    // order_email='commandes@fournisseur-test.com' est inventé → devrait passer en mode custom input.
    const customInput = page.locator('input[placeholder="fournisseur@exemple.com"]')
    await customInput.waitFor({ state: 'visible', timeout: 3000 })
    const val = await customInput.inputValue()
    assert.strictEqual(val, 'commandes@fournisseur-test.com')
  })
})
