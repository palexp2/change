// OrderDetail (/orders/:id) — cellule « Produit » du tableau Articles :
//   interaction « à la Airtable ». La cellule montre le produit en pastille ;
//   SÉLECTIONNÉE (un simple clic), elle offre :
//     - le « × » qui dissocie le produit (cellule pleine) ;
//     - le « + » qui ouvre la liste recherchable du catalogue (cellule vide).
//   Avant, il fallait double-cliquer pour découvrir un panneau.
//
// Commande jetable créée par le test (1 article avec produit + 1 sans), puis
// supprimée dans after(). Aucun enregistrement réel n'est touché.
//
// Auth : ERP_PASS (formulaire) OU ERP_TOKEN (JWT injecté en localStorage).

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
const TOKEN = process.env.ERP_TOKEN
if (!PASS && !TOKEN) throw new Error('ERP_PASS ou ERP_TOKEN requis')

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

describe('OrderDetail — cellule Produit : pastille, « × » et « + »', () => {
  let browser, ctx, page
  let orderId = null
  let product = null
  let items = []

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
    if (TOKEN) await ctx.addInitScript(t => localStorage.setItem('erp_token', t), TOKEN)
    page = await ctx.newPage()
    if (TOKEN) {
      await page.goto(URL + '/', { waitUntil: 'domcontentloaded' })
    } else {
      await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
      await page.fill('input[type="email"]', EMAIL)
      await page.fill('input[type="password"]', PASS)
      await page.click('button:has-text("Se connecter")')
      await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
    }

    const products = await apiFetch(page, '/api/products?limit=200')
    assert.equal(products.status, 200)
    const usable = (products.body.data || []).filter(p => p.name_fr || p.name)
    assert.ok(usable.length, 'aucun produit disponible')
    product = usable[0]

    // Commande jetable, SANS `items` dans le corps : la colonne legacy Airtable
    // `orders.items` capterait le tableau et la création partirait en 400.
    // Les deux articles s'ajoutent donc par la route dédiée.
    const orderRes = await apiFetch(page, '/api/orders', {
      method: 'POST',
      body: JSON.stringify({ notes: `E2E product-chip-cell ${Date.now()}` }),
    })
    assert.ok(orderRes.status === 200 || orderRes.status === 201, `order create failed: ${JSON.stringify(orderRes.body)}`)
    orderId = orderRes.body.id

    for (const body of [{ product_id: product.id, qty: 1 }, { qty: 1 }]) {
      const r = await apiFetch(page, `/api/orders/${orderId}/items`, { method: 'POST', body: JSON.stringify(body) })
      assert.ok(r.status === 200 || r.status === 201, `item create failed: ${JSON.stringify(r.body)}`)
    }

    const detail = await apiFetch(page, `/api/orders/${orderId}`)
    items = detail.body.items || []
    assert.ok(items.length >= 1, 'aucun article dans la commande jetable')
  })

  after(async () => {
    if (orderId) {
      try { await apiFetch(page, `/api/orders/${orderId}`, { method: 'DELETE' }) } catch {}
    }
    await browser?.close()
  })

  test('cellule pleine : pastille, puis « × » quand elle est sélectionnée', async () => {
    await page.goto(`${URL}/orders/${orderId}`, { waitUntil: 'domcontentloaded' })
    const withProduct = items.find(i => i.product_id === product.id)
    assert.ok(withProduct, 'article avec produit absent')

    const cell = page.locator(`[data-grid-cell="${withProduct.id}|product_id"]`)
    await cell.waitFor({ state: 'visible', timeout: 30000 })
    await cell.scrollIntoViewIfNeeded()

    // Au repos : la pastille, rien d'autre.
    const chip = cell.locator('.chip-record').first()
    await chip.waitFor({ state: 'visible', timeout: 10000 })
    assert.equal(await cell.locator('[data-testid^="link-chip-remove-"]').count(), 0,
      'le « × » ne doit pas s’afficher sur une cellule non sélectionnée')

    // Un simple clic sélectionne → le « × » apparaît (sans rien écrire).
    await cell.click({ position: { x: 5, y: 12 } })
    await cell.locator(`[data-testid="link-chip-remove-${product.id}"]`).waitFor({ state: 'visible', timeout: 5000 })

    // Lien monolien : pas de « + » tant qu'un produit est en place.
    assert.equal(await cell.locator('[data-testid="link-chip-add"]').count(), 0,
      'une cellule monolien déjà remplie ne doit pas offrir « + »')
  })

  test('cellule vide : « + » ouvre la liste recherchable', async () => {
    const empty = items.find(i => !i.product_id)
    assert.ok(empty, 'article sans produit absent')
    const cell = page.locator(`[data-grid-cell="${empty.id}|product_id"]`)
    await cell.waitFor({ state: 'visible', timeout: 10000 })
    await cell.click({ position: { x: 5, y: 12 } })

    const add = cell.locator('[data-testid="link-chip-add"]')
    await add.waitFor({ state: 'visible', timeout: 5000 })
    await add.click()

    // Panneau = la liste seule (les pastilles restent dans la cellule).
    await page.waitForSelector('[data-testid="link-editor-search"]', { timeout: 5000 })
    assert.equal(await page.locator('[data-testid="link-editor-current"]').count(), 0,
      'le panneau ne doit plus porter l’en-tête de pastilles')
    assert.ok(await page.locator('[data-testid="link-editor-option"]').count() > 0,
      'la liste du catalogue doit proposer des produits')
    await page.keyboard.press('Escape')
  })
})
