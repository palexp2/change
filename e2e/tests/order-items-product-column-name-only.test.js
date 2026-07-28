// OrderDetail (/orders/:id) — colonne « Produit » du tableau Articles :
//   doit afficher UNIQUEMENT le nom du produit (lien vers la fiche produit),
//   sans vignette d'image ni SKU (signalement utilisateur).
//
// Le test crée une commande jetable avec 1 article dont le produit possède un
// SKU (et une image si possible), puis vérifie que la cellule Produit :
//   - contient le nom du produit (lien /products/:id) ;
//   - ne contient aucun élément <img> ;
//   - ne contient pas le texte du SKU.
// Cleanup dans after() : suppression de la commande créée.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

async function login(page) {
  await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASS)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
}

async function apiFetch(page, path, init = {}) {
  return await page.evaluate(async ({ path, init }) => {
    const tok = localStorage.getItem('erp_token')
    const headers = Object.assign({}, init.headers || {}, { Authorization: `Bearer ${tok}` })
    if (init.body) headers['Content-Type'] = 'application/json'
    const r = await fetch('/erp' + path, { ...init, headers })
    const text = await r.text()
    try { return { status: r.status, body: JSON.parse(text) } } catch { return { status: r.status, body: text } }
  }, { path, init })
}

describe('OrderDetail — colonne Produit du tableau Articles : nom seulement', () => {
  let browser, ctx, page
  let orderId = null
  let product = null

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await login(page)

    // Choisit un produit avec SKU (idéalement avec image) pour vérifier que
    // ni l'un ni l'autre n'apparaissent dans la colonne.
    const products = await apiFetch(page, '/api/products?limit=200')
    assert.equal(products.status, 200)
    const withSku = (products.body.data || []).filter(p => p.sku && (p.name_fr || p.name))
    assert.ok(withSku.length, 'aucun produit avec SKU disponible')
    product = withSku.find(p => p.image || p.image_url || p.photo) || withSku[0]

    // Commande jetable (statut 'En attente' — contrainte CHECK sur orders.status).
    const orderRes = await apiFetch(page, '/api/orders', {
      method: 'POST',
      body: JSON.stringify({
        status: 'En attente',
        notes: `E2E product-column-name-only ${Date.now()}`,
        items: [{ product_id: product.id, qty: 1 }],
      }),
    })
    assert.ok(orderRes.status === 200 || orderRes.status === 201, `order create failed: ${JSON.stringify(orderRes.body)}`)
    orderId = orderRes.body.id
  })

  after(async () => {
    if (orderId) {
      try { await apiFetch(page, `/api/orders/${orderId}`, { method: 'DELETE' }) } catch {}
    }
    await browser?.close()
  })

  test('la cellule Produit affiche le nom sans image ni SKU', async () => {
    await page.goto(`${URL}/orders/${orderId}`, { waitUntil: 'domcontentloaded' })

    // Attend le rendu du tableau Articles (ligne présente via son bouton delete).
    const detail = await apiFetch(page, `/api/orders/${orderId}`)
    assert.equal(detail.status, 200)
    const item = (detail.body.items || [])[0]
    assert.ok(item, 'article absent de la commande')
    await page.waitForSelector(`[data-testid="item-delete-${item.id}"]`, { timeout: 15000 })

    // La cellule Produit = conteneur du lien vers la fiche produit.
    const link = page.locator(`a[href$="/products/${product.id}"]`).first()
    await link.waitFor({ state: 'visible', timeout: 10000 })
    const name = product.name_fr || product.name
    const linkText = (await link.textContent())?.trim()
    assert.equal(linkText, name, `le lien doit afficher le nom du produit (vu: « ${linkText} »)`)

    // Conteneur de la cellule (div racine du render product_name).
    const cell = link.locator('xpath=ancestor::div[contains(@class, "min-w-0")][1]')

    // 1. Aucune image dans la cellule.
    const imgCount = await cell.locator('img').count()
    assert.equal(imgCount, 0, 'la cellule Produit ne doit contenir aucune image')

    // 2. Le SKU n'apparaît pas dans la cellule.
    const cellText = (await cell.textContent()) || ''
    assert.ok(!cellText.includes(item.sku || product.sku), `le SKU « ${product.sku} » ne doit pas apparaître dans la cellule (vu: « ${cellText.trim()} »)`)
  })
})
