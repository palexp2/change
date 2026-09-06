// Vérifie l'endpoint /api/dashboard/top-products et le rendu du panel
// "Meilleurs vendeurs" (toggle revenus/quantité, slider de plage de temps,
// presets, top liste).
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Dashboard — Meilleurs vendeurs', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => { await browser?.close() })

  test('endpoint /api/dashboard/top-products retourne products[] et range', async () => {
    const data = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/dashboard/top-products', { headers: { Authorization: `Bearer ${tok}` } })
      return r.json()
    })
    assert.ok(Array.isArray(data.products), 'products doit être un array')
    assert.ok(data.products.length > 0, 'aucun produit retourné — liste vide')
    assert.ok(data.range && data.range.min_date && data.range.max_date, 'range.min_date / max_date manquants')
    // Structure d'un produit
    const p = data.products[0]
    assert.equal(typeof p.quantity, 'number', 'quantity doit être un number')
    assert.equal(typeof p.amount_cad, 'number', 'amount_cad doit être un number')
    assert.equal(typeof p.invoice_count, 'number', 'invoice_count doit être un number')
  })

  test('endpoint accepte les filtres from/to et restreint le résultat', async () => {
    // Plage très étroite (un seul jour très ancien) → peu ou pas de produits
    const tight = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/dashboard/top-products?from=1999-01-01&to=1999-01-02', { headers: { Authorization: `Bearer ${tok}` } })
      return r.json()
    })
    assert.ok(Array.isArray(tight.products), 'products doit être un array')
    // Plage très large
    const wide = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/dashboard/top-products?from=2000-01-01&to=2099-12-31', { headers: { Authorization: `Bearer ${tok}` } })
      return r.json()
    })
    assert.ok(wide.products.length >= tight.products.length,
      `wide=${wide.products.length} < tight=${tight.products.length} (filtrage de date inversé ?)`)
    assert.ok(wide.products.length > 0, 'plage large devrait retourner des produits')
  })

  test('le panel UI affiche les contrôles et la liste', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="section-top-products"]', { timeout: 10000 })

    const title = await page.locator('[data-testid="section-top-products"] h2').innerText()
    assert.match(title, /Meilleurs vendeurs/, `titre inattendu: ${title}`)

    // Toggle metric
    await page.waitForSelector('[data-testid="dashboard-top-products-metric-amount"]', { timeout: 5000 })
    await page.waitForSelector('[data-testid="dashboard-top-products-metric-quantity"]', { timeout: 5000 })

    // Slider présent
    await page.waitForSelector('[data-testid="dashboard-top-products-slider"]', { timeout: 5000 })

    // Presets
    await page.waitForSelector('[data-testid="dashboard-top-products-preset-1y"]', { timeout: 5000 })
    await page.waitForSelector('[data-testid="dashboard-top-products-preset-all"]', { timeout: 5000 })

    // Liste (peut prendre une seconde à charger)
    await page.waitForSelector('[data-testid="dashboard-top-products-list"]', { timeout: 10000 })
    const rowCount = await page.locator('[data-testid="dashboard-top-products-list"] li').count()
    assert.ok(rowCount > 0, 'aucune ligne de produit dans la liste')
  })

  test('basculer "Par quantité" change l\'ordre du Top 1', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="dashboard-top-products-list"] li', { timeout: 10000 })

    // Sélectionne preset Tout pour avoir des données stables
    await page.click('[data-testid="dashboard-top-products-preset-all"]')
    await page.waitForTimeout(800)

    const firstByAmount = await page.locator('[data-testid="dashboard-top-products-list"] li').first().innerText()

    await page.click('[data-testid="dashboard-top-products-metric-quantity"]')
    await page.waitForTimeout(400)

    const firstByQty = await page.locator('[data-testid="dashboard-top-products-list"] li').first().innerText()

    // Au moins l'unité d'affichage doit changer (CAD → "u.")
    assert.ok(firstByQty.includes('u.'),
      `passage en quantité devrait afficher des unités: "${firstByQty}"`)
    assert.ok(!firstByAmount.includes(' u.') || firstByAmount !== firstByQty,
      'la métrique a-t-elle réellement changé ?')
  })

  test('cliquer sur le preset 30j change la plage affichée', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="dashboard-top-products-from"]', { timeout: 10000 })

    await page.click('[data-testid="dashboard-top-products-preset-all"]')
    await page.waitForTimeout(500)
    const fromAll = await page.locator('[data-testid="dashboard-top-products-from"]').innerText()

    await page.click('[data-testid="dashboard-top-products-preset-30d"]')
    await page.waitForTimeout(500)
    const from30 = await page.locator('[data-testid="dashboard-top-products-from"]').innerText()

    assert.notEqual(fromAll, from30, `preset 30j n'a pas changé la borne basse (toujours "${fromAll}")`)
  })
})
