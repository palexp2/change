const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Régression : les champs natifs de products (Nom, SKU, Image…) avaient disparu
// du sélecteur de colonnes après la fusion airtable_field_defs → custom_fields
// (les défs native_* ne migrent plus côté serveur, et tableDefs.products était
// vide). Le test vérifie que la colonne Image est de retour dans le panneau
// « Champs » et que les vignettes se rendent. Lecture seule : aucun record créé,
// aucune case cochée/décochée (pas de mutation des pills partagées).
describe('Products — colonne Image et champs natifs restaurés', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
    await page.goto(URL + '/products', { waitUntil: 'domcontentloaded' })
    // La vue « Pour vente » affiche image_url et des lignes (is_sellable=1).
    await page.click('button:has-text("Pour vente")', { timeout: 15000 })
    await page.waitForSelector('text=Nom', { timeout: 15000 })
    // L'hydratation du data store (bootstrap) peut prendre >10s : attendre que
    // les lignes soient chargées avant les assertions sur le contenu.
    await page.waitForSelector('text=Chargement...', { state: 'detached', timeout: 60000 })
  })

  after(async () => {
    await browser?.close()
  })

  test('les colonnes natives (Nom, SKU) sont rendues dans le tableau', async () => {
    assert.ok(await page.locator('text=SKU').first().isVisible(), 'header SKU visible')
    assert.ok(await page.locator('text=Nom').first().isVisible(), 'header Nom visible')
  })

  // NB : ne pas utiliser input[placeholder="Rechercher..."] — la recherche
  // globale du DataTable porte le même placeholder et filtrerait les lignes.
  test('le panneau Champs propose la colonne Image', async () => {
    await page.click('button:has-text("Champs")')
    await page.waitForSelector('text=Colonnes visibles', { timeout: 5000 })
    const row = page.locator('label', { hasText: /^Image$/ }).first()
    await row.waitFor({ state: 'attached', timeout: 5000 })
    // Dans la pill « Pour vente », image_url fait partie des colonnes visibles.
    assert.equal(await row.locator('input[type="checkbox"]').isChecked(), true,
      'Image cochée dans la vue Pour vente')
  })

  test('le champ Airtable « Quantité à commander » est toujours listé (pas de collision de label)', async () => {
    const row = page.locator('label', { hasText: 'Quantité à commander' }).first()
    await row.waitFor({ state: 'attached', timeout: 5000 })
    assert.ok((await row.count()) > 0)
    await page.keyboard.press('Escape')
  })

  test('des vignettes produit se rendent dans la colonne Image', async () => {
    const img = page.locator('img[src*="/product-images/"]').first()
    await img.waitFor({ state: 'visible', timeout: 15000 })
    assert.ok(await img.isVisible(), 'au moins une vignette rendue')
  })
})
