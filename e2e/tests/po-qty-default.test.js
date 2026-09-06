const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('PO — qty par défaut = order_qty (fallback sur quantite_a_commander legacy)', () => {
  let browser, ctx, page, productId, originalOrderQty

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
      const p = list.find(x => x.buy_via_po)
      return p ? { id: p.id, order_qty: p.order_qty } : null
    })
    assert.ok(picked, 'aucun produit buy_via_po trouvé')
    productId = picked.id
    originalOrderQty = picked.order_qty
  })

  after(async () => {
    if (productId != null) {
      await page.evaluate(async ({ id, qty }) => {
        const token = localStorage.getItem('erp_token')
        const prod = await fetch(`/erp/api/products/${id}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
        await fetch(`/erp/api/products/${id}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...prod, order_qty: qty }),
        })
      }, { id: productId, qty: originalOrderQty ?? 0 })
    }
    await browser?.close()
  })

  test('prefill reflète order_qty quand renseignée', async () => {
    const result = await page.evaluate(async (id) => {
      const token = localStorage.getItem('erp_token')
      const prod = await fetch(`/erp/api/products/${id}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
      await fetch(`/erp/api/products/${id}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...prod, order_qty: 7 }),
      })
      const pre = await fetch(`/erp/api/products/${id}/purchase-order/prefill`, {
        headers: { Authorization: `Bearer ${token}` },
      }).then(r => r.json())
      return pre
    }, productId)
    assert.strictEqual(result.items?.[0]?.qty, 7)
  })

  test('prefill utilise quantite_a_commander (legacy Airtable) quand order_qty = 0', async () => {
    // Produit spécifique qui a quantite_a_commander = "6" côté Airtable, order_qty = 0 côté ERP.
    const SPECIFIC_ID = '7777e880-5af8-486b-aadf-88ba1c0ed017'
    const result = await page.evaluate(async (id) => {
      const token = localStorage.getItem('erp_token')
      const prod = await fetch(`/erp/api/products/${id}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
      // Forcer order_qty = 0 pour s'assurer du fallback
      await fetch(`/erp/api/products/${id}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...prod, order_qty: 0 }),
      })
      const pre = await fetch(`/erp/api/products/${id}/purchase-order/prefill`, {
        headers: { Authorization: `Bearer ${token}` },
      }).then(r => r.json())
      return { qty: pre.items?.[0]?.qty, quantite_a_commander: prod.quantite_a_commander }
    }, SPECIFIC_ID)
    assert.strictEqual(Number(result.quantite_a_commander), 6, 'fixture attendu: quantite_a_commander=6')
    assert.strictEqual(result.qty, 6, 'le prefill doit utiliser quantite_a_commander quand order_qty = 0')
  })
})
