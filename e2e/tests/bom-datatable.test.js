const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('ProductDetail — onglet BOM en DataTable', () => {
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

    // Trouver un produit qui a au moins un bom_item
    const picked = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const res = await fetch('/erp/api/projets/bom?limit=all', { headers: { Authorization: `Bearer ${token}` } })
      const data = await res.json()
      const list = data.data || []
      if (!list.length) return { id: null }
      // Grouper par product_id, choisir celui qui a le plus de composants
      const counts = {}
      for (const b of list) counts[b.product_id] = (counts[b.product_id] || 0) + 1
      const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]
      return { id: best?.[0] || null, count: best?.[1] || 0 }
    })
    productId = picked.id
    assert.ok(productId, 'aucun produit avec BOM trouvé')
  })

  after(async () => { await browser?.close() })

  async function openBomTab() {
    await page.goto(`${URL}/products/${productId}`, { waitUntil: 'networkidle' })
    await page.click('button:has-text("BOM")')
    // Le compteur "N ligne(s)" de ViewToolbar apparaît quand le DataTable est prêt
    await page.waitForSelector('text=/\\d+\\s+lignes?/', { timeout: 10000 })
  }

  test('onglet BOM affiche la barre d\'outils DataTable (compteur + recherche)', async () => {
    await openBomTab()
    const counterTxt = await page.locator('text=/\\d+\\s+lignes?/').first().textContent()
    const n = parseInt(counterTxt.match(/(\d+)/)[1], 10)
    assert.ok(n > 0, `DataTable BOM doit afficher au moins une ligne (got ${n})`)
    assert.ok(await page.locator('input[placeholder="Rechercher..."]').first().isVisible(),
      'DataTable doit afficher le champ de recherche')
  })

  test('onglet BOM affiche la colonne Composant comme lien cliquable', async () => {
    await openBomTab()
    // Un lien vers /products/<id> doit être visible dans le corps du DataTable
    const firstLink = page.locator('a[href*="/products/"]').filter({ hasNot: page.locator('img') }).first()
    await firstLink.waitFor({ state: 'visible', timeout: 5000 })
    const href = await firstLink.getAttribute('href')
    assert.match(href, /\/products\/[^/]+/, 'le nom de composant doit être un lien vers la fiche produit')
  })

  test('onglet BOM affiche la colonne Image', async () => {
    await openBomTab()
    // En-tête de colonne "Image"
    const header = page.locator('text=/^Image$/i').first()
    await header.waitFor({ state: 'visible', timeout: 5000 })
    // Vérifier via l'API qu'au moins un composant a un image_url, puis confirmer dans le DOM
    const hasImage = await page.evaluate(async (id) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch(`/erp/api/projets/bom?product_id=${id}&limit=all`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const d = await r.json()
      return (d.data || []).some(b => b.component_image_url)
    }, productId)
    if (hasImage) {
      // Au moins une image est rendue dans le DataTable (hors headers)
      const img = page.locator('img[alt]').first()
      await img.waitFor({ state: 'visible', timeout: 5000 })
    }
  })

  test('recherche DataTable filtre les lignes BOM', async () => {
    await openBomTab()
    const counterBefore = await page.locator('text=/\\d+\\s+lignes?/').first().textContent()
    const before = parseInt(counterBefore.match(/(\d+)/)[1], 10)

    await page.fill('input[placeholder="Rechercher..."]', 'zzzzzzzz_aucune_correspondance')
    await page.waitForTimeout(500)
    const counterAfter = await page.locator('text=/\\d+\\s+lignes?/').first().textContent()
    const after = parseInt(counterAfter.match(/(\d+)/)[1], 10)
    assert.ok(after < before, `la recherche n'a pas filtré: avant=${before} après=${after}`)

    await page.fill('input[placeholder="Rechercher..."]', '')
  })
})
