// Test : Architecture accessible depuis Admin (non depuis la sidebar)
// Vérifie que le lien Architecture a été déplacé de la navigation principale
// vers l'onglet Architecture de la page Admin.

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

describe('Admin — onglet Architecture', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await login(page)
  })

  after(async () => {
    await browser?.close()
  })

  test('Architecture n\'est plus en lien direct dans la sidebar', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })

    // Vérifier que le lien "Architecture" N'existe pas dans la sidebar.
    const archLink = page.locator('nav a[href="/erp/architecture"], nav button:has-text("Architecture")')
    const count = await archLink.count()
    assert.equal(count, 0, 'le lien Architecture ne doit pas être dans la navigation principale')
  })

  test('Architecture est accessible via l\'onglet Admin', async () => {
    // Accéder à la page Admin
    await page.goto(URL + '/admin', { waitUntil: 'networkidle' })

    // Vérifier que l'onglet Architecture existe
    const archTab = page.locator('button:has-text("Architecture")')
    await archTab.waitFor({ state: 'visible', timeout: 5000 })
    assert.ok(await archTab.isVisible(), 'onglet Architecture doit être visible dans Admin')

    // Cliquer sur l'onglet
    await archTab.click()

    // Vérifier que le contenu Architecture s'affiche
    // (title + stats + tabs internes)
    const title = page.locator('h1:has-text("Architecture")')
    await title.waitFor({ state: 'visible', timeout: 5000 })

    // Vérifier que les stats s'affichent
    const statsCards = page.locator('[class*="grid"]:has(div:has-text("Pages"))')
    await statsCards.first().waitFor({ state: 'visible', timeout: 5000 })

    // Vérifier que les onglets internes (Carte des modules, Inventaire technique) existent
    const mapTab = page.locator('button:has-text("Carte des modules")')
    const inventoryTab = page.locator('button:has-text("Inventaire technique")')
    await mapTab.waitFor({ state: 'visible', timeout: 5000 })
    await inventoryTab.waitFor({ state: 'visible', timeout: 5000 })
  })

  test('Contenu Architecture fonctionne correctement dans Admin', async () => {
    await page.goto(URL + '/admin/architecture', { waitUntil: 'networkidle' })

    // Vérifier la carte des modules (onglet par défaut)
    const map = page.locator('[data-testid="arch-map"]')
    await map.waitFor({ state: 'visible', timeout: 5000 })

    // Vérifier qu'on peut basculer vers l'inventaire
    await page.click('[data-testid="arch-tab-inventory"]')
    const inventory = page.locator('[data-testid="arch-inventory"]')
    await inventory.waitFor({ state: 'visible', timeout: 5000 })

    // Vérifier le contenu d'inventaire
    const invText = await inventory.innerText()
    assert.ok(invText.includes('/api/'), 'inventaire doit lister des endpoints API')
  })

  test('URL /architecture redirige vers /admin/architecture', async () => {
    await page.goto(URL + '/architecture', { waitUntil: 'networkidle' })

    // La page /architecture doit toujours fonctionner (composant exporté reste accessible)
    assert.ok(page.url().includes('/architecture'), 'page /architecture doit rester accessible')

    // Vérifier que le contenu Architecture s'affiche
    const title = page.locator('h1:has-text("Architecture")')
    await title.waitFor({ state: 'visible', timeout: 5000 })
  })
})
