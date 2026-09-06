// Vérifie le side-peek (RecordPeekDrawer) sur la table Produits (/products) :
//  - un clic sur une ligne ouvre le drawer latéral SANS démonter la liste
//  - la barre d'adresse affiche l'URL de la fiche (/products/:id) pendant que
//    le panneau est ouvert
//  - le drawer rend la fiche ProductDetail embarquée (onglets + champs)
//  - le bouton « ouvrir en grand » navigue vers /products/:id
//  - Échap ferme le drawer et restaure l'URL de la liste
//  - la fiche plein écran offre le bouton « revenir au panneau latéral »
//
// Lecture seule : on n'édite aucun champ, donc aucun record n'est créé ni muté
// (rien à nettoyer/restaurer).
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const BASE = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Produits — side-peek drawer', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => { await browser?.close() })

  // Ouvre le drawer sur la première ligne. Le clic vise une zone de texte
  // neutre (x=260 ≈ colonne Nom), le handler d'ouverture étant porté par la
  // ligne elle-même.
  async function openFirstRowPeek() {
    await page.goto(`${BASE}/products`, { waitUntil: 'networkidle' })
    const firstRow = page.locator('[data-row-id]').first()
    await firstRow.waitFor({ timeout: 15000 })
    const rowId = await firstRow.getAttribute('data-row-id')
    await firstRow.click({ position: { x: 260, y: 12 } })
    await page.locator('[data-testid="record-peek-drawer"]').waitFor({ timeout: 10000 })
    return rowId
  }

  test('clic sur une ligne ouvre le drawer et affiche l’URL de la fiche', async () => {
    const rowId = await openFirstRowPeek()
    // La liste est toujours montée derrière le panneau.
    assert.ok(await page.locator('[data-row-id]').count() > 0,
      'les lignes de la liste restent affichées derrière le drawer')
    // Barre d'adresse = URL de la fiche.
    const path = new URL(page.url()).pathname
    assert.ok(path.endsWith(`/products/${rowId}`),
      `l'URL doit être celle de la fiche (url=${page.url()})`)
    // Corps du drawer : fiche produit embarquée.
    const body = await page.locator('[data-testid="record-peek-body"]').innerText()
    assert.ok(/Informations/i.test(body), 'le drawer affiche l’onglet Informations')
    assert.ok(/Mouvements de stock/i.test(body), 'le drawer affiche l’onglet Mouvements de stock')
    assert.ok(/SKU/i.test(body), 'le drawer affiche le champ SKU')
    // Pas de chrome de page dans le panneau (titre h1 + bouton retour).
    const drawer = page.locator('[data-testid="record-peek-drawer"]')
    assert.equal(await drawer.locator('h1').count(), 0,
      'pas de titre h1 dans le drawer (le drawer fournit le sien)')
    assert.equal(await drawer.locator('[data-testid="product-open-as-peek"]').count(), 0,
      'pas de bouton « revenir au panneau » dans le drawer lui-même')
  })

  test('Échap ferme le drawer et restaure l’URL de la liste', async () => {
    await openFirstRowPeek()
    await page.keyboard.press('Escape')
    await page.locator('[data-testid="record-peek-drawer"]').waitFor({ state: 'detached', timeout: 8000 })
    await page.waitForFunction(() => window.location.pathname.endsWith('/products'), null, { timeout: 8000 })
    assert.ok(new URL(page.url()).pathname.endsWith('/products'),
      `l'URL revient à la liste (url=${page.url()})`)
  })

  test('bouton « ouvrir en grand » navigue vers la fiche complète', async () => {
    const rowId = await openFirstRowPeek()
    await page.click('[data-testid="record-peek-expand"]')
    await page.waitForURL(u => u.toString().includes(`/products/${rowId}`), { timeout: 10000 })
    assert.equal(await page.locator('[data-testid="record-peek-drawer"]').count(), 0,
      'le drawer est fermé après navigation')
    // La fiche complète garde son chrome : titre h1 + bouton retour au panneau.
    await page.locator('h1').first().waitFor({ timeout: 10000 })
    await page.locator('[data-testid="product-open-as-peek"]').waitFor({ timeout: 10000 })
  })

  test('« revenir au panneau latéral » rouvre le drawer sur la liste', async () => {
    const rowId = await openFirstRowPeek()
    await page.click('[data-testid="record-peek-expand"]')
    await page.waitForURL(u => u.toString().includes(`/products/${rowId}`), { timeout: 10000 })
    const btn = page.locator('[data-testid="product-open-as-peek"]')
    await btn.waitFor({ timeout: 10000 })
    await btn.click()
    await page.locator('[data-testid="record-peek-drawer"]').waitFor({ timeout: 10000 })
    assert.ok(await page.locator('[data-row-id]').count() > 0,
      'de retour sur la liste avec le drawer ouvert')
    // Un refresh ne doit PAS rouvrir le drawer (state d'historique nettoyé).
    await page.goto(`${BASE}/products`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(1500)
    assert.equal(await page.locator('[data-testid="record-peek-drawer"]').count(), 0,
      'le drawer ne se rouvre pas sur une visite normale de la liste')
  })
})
