const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

// Vérifie la migration des tableaux d'historique read-only vers <DataTable> :
//  - onglet « Mouvements » de ProductDetail (mouvements de stock)
//  - panneau « Journal de synchronisation » de Connectors (logs de sync)
// Test purement lecture : ne crée ni ne modifie aucun record → pas de cleanup nécessaire.

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Historiques read-only en DataTable (mouvements produit + journal sync)', () => {
  let browser, ctx, page, productId

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    // Trouver un produit qui possède au moins un mouvement de stock
    productId = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const res = await fetch('/erp/api/stock-movements?limit=50', { headers: { Authorization: `Bearer ${token}` } })
      const data = await res.json()
      const list = data.data || data || []
      const withProduct = list.find(m => m.product_id)
      return withProduct ? withProduct.product_id : null
    })
    assert.ok(productId, 'aucun mouvement de stock rattaché à un produit trouvé')
  })

  after(async () => { await browser?.close() })

  async function openMouvementsTab() {
    await page.goto(`${URL}/products/${productId}`, { waitUntil: 'networkidle' })
    await page.click('button:has-text("Mouvements")')
    // Le compteur "N ligne(s)" de ViewToolbar n'apparaît que dans un DataTable
    await page.waitForSelector('text=/\\d+\\s+lignes?/', { timeout: 10000 })
  }

  test('onglet Mouvements affiche la barre d\'outils DataTable (compteur + recherche)', async () => {
    await openMouvementsTab()
    const counterTxt = await page.locator('text=/\\d+\\s+lignes?/').first().textContent()
    const n = parseInt(counterTxt.match(/(\d+)/)[1], 10)
    assert.ok(n > 0, `DataTable Mouvements doit afficher au moins une ligne (got ${n})`)
    assert.ok(await page.locator('input[placeholder="Rechercher..."]').first().isVisible(),
      'DataTable doit afficher le champ de recherche')
  })

  test('recherche DataTable filtre les mouvements de stock', async () => {
    await openMouvementsTab()
    const before = parseInt(
      (await page.locator('text=/\\d+\\s+lignes?/').first().textContent()).match(/(\d+)/)[1], 10)

    await page.fill('input[placeholder="Rechercher..."]', 'zzzzzzzz_aucune_correspondance')
    await page.waitForTimeout(500)
    const after = parseInt(
      (await page.locator('text=/\\d+\\s+lignes?/').first().textContent()).match(/(\d+)/)[1], 10)
    assert.ok(after < before, `la recherche n'a pas filtré: avant=${before} après=${after}`)

    await page.fill('input[placeholder="Rechercher..."]', '')
  })

  test('journal de synchronisation (Connectors) s\'affiche en DataTable', async () => {
    await page.goto(`${URL}/connectors`, { waitUntil: 'networkidle' })
    // Déplier le panneau "Journal de synchronisation"
    await page.click('button:has-text("Journal de synchronisation")')
    // Le DataTable rend son compteur de lignes une fois les logs chargés
    await page.waitForSelector('text=/\\d+\\s+lignes?/', { timeout: 10000 })

    const n = parseInt(
      (await page.locator('text=/\\d+\\s+lignes?/').first().textContent()).match(/(\d+)/)[1], 10)
    assert.ok(n > 0, `le journal de sync doit afficher au moins une ligne (got ${n})`)
    assert.ok(await page.locator('input[placeholder="Rechercher..."]').first().isVisible(),
      'le DataTable du journal doit afficher le champ de recherche')
  })

  test('recherche DataTable filtre les logs de synchronisation', async () => {
    await page.goto(`${URL}/connectors`, { waitUntil: 'networkidle' })
    await page.click('button:has-text("Journal de synchronisation")')
    await page.waitForSelector('text=/\\d+\\s+lignes?/', { timeout: 10000 })

    const before = parseInt(
      (await page.locator('text=/\\d+\\s+lignes?/').first().textContent()).match(/(\d+)/)[1], 10)

    await page.fill('input[placeholder="Rechercher..."]', 'zzzzzzzz_aucune_correspondance')
    await page.waitForTimeout(500)
    const after = parseInt(
      (await page.locator('text=/\\d+\\s+lignes?/').first().textContent()).match(/(\d+)/)[1], 10)
    assert.ok(after < before, `la recherche n'a pas filtré les logs: avant=${before} après=${after}`)

    await page.fill('input[placeholder="Rechercher..."]', '')
  })
})
