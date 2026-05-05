const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie que la fiche détaillée d'une facture client (source 'stripe') affiche
// la table « Lignes de la facture » avec une ligne par produit, et que la cellule
// Produit est un lien cliquable vers /products/:id.
describe('FactureDetail — une ligne par produit', () => {
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

  test('API: /projets/factures/:id retourne items[] pour une facture Stripe', async () => {
    // Trouve une facture qui a des stripe_invoice_items en base
    const res = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const h = { Authorization: `Bearer ${token}` }
      // Récupère une ligne d'item liée à une facture
      const list = await fetch('/erp/api/stripe-invoice-items?limit=1', { headers: h }).then(r => r.json())
      const sii = list.data?.find(i => i.facture_id)
      if (!sii) return { skipped: true }
      const facture = await fetch(`/erp/api/projets/factures/${sii.facture_id}`, { headers: h }).then(r => r.json())
      return {
        skipped: false,
        factureId: sii.facture_id,
        source: facture.source,
        itemsCount: Array.isArray(facture.items) ? facture.items.length : null,
        firstItem: facture.items?.[0],
      }
    })
    if (res.skipped) {
      console.log('# SKIP: aucune facture Stripe avec items en base')
      return
    }
    assert.equal(res.source, 'stripe', 'source attendue: stripe')
    assert.ok(res.itemsCount > 0, `items[] doit être non-vide, reçu ${res.itemsCount}`)
    const it = res.firstItem
    assert.ok(it && typeof it === 'object', 'le 1er item doit être un objet')
    assert.ok('description' in it, 'item doit avoir description')
    assert.ok('qty' in it, 'item doit avoir qty')
    assert.ok('unit_price' in it, 'item doit avoir unit_price (en unités, pas cents)')
  })

  test('UI: la table "Lignes de la facture" s\'affiche avec colonne Produit cliquable si lié', async () => {
    // Trouve une facture Stripe dont au moins un item a product_id
    const setup = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const h = { Authorization: `Bearer ${token}` }
      const list = await fetch('/erp/api/stripe-invoice-items?linked=1&limit=1', { headers: h }).then(r => r.json())
      const sii = list.data?.find(i => i.facture_id && i.product_id)
      if (!sii) {
        // Fallback : prendre n'importe quelle facture avec items, même non liés
        const any = await fetch('/erp/api/stripe-invoice-items?limit=1', { headers: h }).then(r => r.json())
        const a = any.data?.find(i => i.facture_id)
        if (!a) return { skipped: true }
        return { skipped: false, factureId: a.facture_id, productId: null }
      }
      return { skipped: false, factureId: sii.facture_id, productId: sii.product_id }
    })
    if (setup.skipped) {
      console.log('# SKIP: aucune facture Stripe avec items en base')
      return
    }

    await page.goto(`${URL}/factures/${setup.factureId}`, { waitUntil: 'networkidle' })
    const itemsCard = page.locator('[data-testid="facture-items"]')
    await itemsCard.waitFor({ timeout: 5000 })

    // En-têtes
    const headers = await itemsCard.locator('thead th').allTextContents()
    assert.ok(headers.some(h => h.trim() === 'Produit'), `colonne Produit attendue, reçu: ${headers}`)
    assert.ok(headers.some(h => h.trim() === 'Description'), `colonne Description attendue`)

    // Au moins une ligne
    const rowCount = await itemsCard.locator('tbody tr').count()
    assert.ok(rowCount >= 1, `au moins 1 ligne attendue, reçu ${rowCount}`)

    if (setup.productId) {
      // Vérifie qu'au moins une cellule Produit est un lien vers /products/:id
      const link = itemsCard.locator(`a[href="/products/${setup.productId}"], a[href="/erp/products/${setup.productId}"]`).first()
      await link.waitFor({ timeout: 3000 })
      const text = (await link.textContent() || '').trim()
      assert.ok(text.length > 0, 'le lien produit doit avoir un libellé')
    }
  })
})
