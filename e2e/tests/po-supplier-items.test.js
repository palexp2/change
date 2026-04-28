const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('PO — articles groupés par fournisseur + picker', () => {
  let browser, ctx, page
  // Pick supplier + 2 products from same supplier for the scenario
  let supplierId, prodA, prodB, prodC
  // snapshot originals to restore after
  let origA, origB, origC

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    // Find a supplier that has >= 2 products, with at least one having buy_via_po=1 (so the PO button shows).
    // Prefer 3 so we can also assert "order_qty=0 not auto-added"; fall back to 2.
    const picked = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const res = await fetch('/erp/api/products?limit=all', { headers: { Authorization: `Bearer ${token}` } })
      const data = await res.json()
      const list = data.data || data
      const withSup = list.filter(p => p.supplier_company_id)
      const bySup = {}
      for (const p of withSup) {
        (bySup[p.supplier_company_id] ||= []).push(p)
      }
      // helper: sort so buy_via_po products come first (first product is the one we'll open)
      const sortByPo = (prods) => [...prods].sort((a, b) => (b.buy_via_po ? 1 : 0) - (a.buy_via_po ? 1 : 0))
      let best = null
      for (const [sid, prods] of Object.entries(bySup)) {
        if (!prods.some(p => p.buy_via_po)) continue
        const sorted = sortByPo(prods)
        if (sorted.length >= 3) {
          best = { supplierId: sid, products: sorted.slice(0, 3).map(p => ({ id: p.id, order_qty: p.order_qty, buy_via_po: !!p.buy_via_po })) }
          break
        }
        if (!best && sorted.length >= 2) {
          best = { supplierId: sid, products: sorted.slice(0, 2).map(p => ({ id: p.id, order_qty: p.order_qty, buy_via_po: !!p.buy_via_po })) }
        }
      }
      return best
    })
    assert.ok(picked, 'besoin d\'un fournisseur avec >= 2 produits')
    supplierId = picked.supplierId
    prodA = picked.products[0].id
    prodB = picked.products[1].id
    prodC = picked.products[2]?.id || null
    origA = picked.products[0].order_qty
    origB = picked.products[1].order_qty
    origC = picked.products[2]?.order_qty ?? null
  })

  after(async () => {
    if (prodA) {
      const triples = [{ id: prodA, qty: origA }, { id: prodB, qty: origB }]
      if (prodC) triples.push({ id: prodC, qty: origC })
      await page.evaluate(async ({ triples }) => {
        const token = localStorage.getItem('erp_token')
        for (const { id, qty } of triples) {
          const prod = await fetch(`/erp/api/products/${id}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
          await fetch(`/erp/api/products/${id}`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...prod, order_qty: qty ?? 0 }),
          })
        }
      }, { triples })
    }
    await browser?.close()
  })

  test('prefill ajoute les autres produits du même fournisseur qui ont order_qty > 0', async () => {
    const result = await page.evaluate(async ({ a, b, c }) => {
      const token = localStorage.getItem('erp_token')
      const setQty = async (id, qty) => {
        const prod = await fetch(`/erp/api/products/${id}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
        await fetch(`/erp/api/products/${id}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...prod, order_qty: qty }),
        })
      }
      // A = 3 (the product opened), B = 5 (should be auto-added), C = 0 (should NOT be in items)
      await setQty(a, 3)
      await setQty(b, 5)
      if (c) await setQty(c, 0)
      const pre = await fetch(`/erp/api/products/${a}/purchase-order/prefill`, {
        headers: { Authorization: `Bearer ${token}` },
      }).then(r => r.json())
      return pre
    }, { a: prodA, b: prodB, c: prodC })

    const itemIds = (result.items || []).map(it => it.product_id).filter(Boolean)
    assert.ok(itemIds.includes(prodA), 'le produit courant doit être dans les items')
    assert.ok(itemIds.includes(prodB), 'un autre produit du même fournisseur avec order_qty>0 doit être auto-ajouté')
    if (prodC) {
      assert.ok(!itemIds.includes(prodC), 'un produit avec order_qty=0 ne doit PAS être auto-ajouté')
    }

    const supplierIds = (result.supplier_products || []).map(p => p.id)
    if (prodC) assert.ok(supplierIds.includes(prodC), 'supplier_products doit contenir tous les produits du fournisseur (pour le picker)')
    assert.ok(supplierIds.includes(prodB))
    assert.ok(supplierIds.includes(prodA))
  })

  test('le modal affiche le bouton "Ajouter une pièce du fournisseur" et ouvre un picker recherchable', async () => {
    await page.goto(`${URL}/products/${prodA}`, { waitUntil: 'domcontentloaded' })
    // Ouvrir le modal PO
    await page.getByRole('button', { name: /générer un po/i }).click()
    await page.getByRole('heading', { name: /bon de commande/i }).waitFor({ timeout: 5000 })

    const picker = page.getByRole('button', { name: /ajouter une pièce du fournisseur/i })
    await picker.waitFor({ timeout: 5000 })
    await picker.click()

    const search = page.getByPlaceholder(/rechercher une pièce/i)
    await search.waitFor({ timeout: 3000 })
    assert.ok(await search.isVisible(), 'input de recherche doit être visible')
  })
})
