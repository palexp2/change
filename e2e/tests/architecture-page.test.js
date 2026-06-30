// Architecture page — mind map du fonctionnement de l'app.
//
// La page est en lecture seule (rendu d'un manifeste généré au build), elle ne
// crée aucun record et ne mute aucune config → pas de cleanup nécessaire.
// Le test vérifie : accès admin, stats, carte des modules (groupes + pages
// navigables), bascule vers l'inventaire technique (mounts API / tables / connecteurs).

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

describe('Architecture — carte du fonctionnement de l\'app', () => {
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

  test('rendu de la carte des modules + bascule inventaire', async () => {
    await page.goto(URL + '/architecture', { waitUntil: 'networkidle' })

    // L'accès admin ne doit pas rediriger vers /dashboard.
    assert.ok(page.url().includes('/architecture'), 'doit rester sur /architecture (admin)')

    // Titre de page.
    await page.waitForSelector('h1:has-text("Architecture")', { timeout: 10000 })

    // Onglet « Carte des modules » actif par défaut → la carte est visible.
    const map = page.locator('[data-testid="arch-map"]')
    await map.waitFor({ state: 'visible', timeout: 5000 })

    // Au moins un domaine connu du menu (groupe « Clients »).
    await assert.doesNotReject(
      page.locator('button:has-text("Clients")').first().waitFor({ state: 'visible', timeout: 5000 }),
      'le domaine « Clients » doit apparaître dans la carte'
    )

    // Le premier groupe est ouvert par défaut → un lien de page navigable existe.
    const contactsLink = page.locator('[data-testid="arch-map"] a[href$="/contacts"]')
    await contactsLink.first().waitFor({ state: 'visible', timeout: 5000 })

    // Bascule vers l'inventaire technique.
    await page.click('[data-testid="arch-tab-inventory"]')
    const inv = page.locator('[data-testid="arch-inventory"]')
    await inv.waitFor({ state: 'visible', timeout: 5000 })

    // L'inventaire doit lister des mounts API, des tables, des connecteurs.
    const invText = await inv.innerText()
    assert.ok(invText.includes('/api/'), 'inventaire doit lister des mounts /api/')
    assert.ok(/orders|companies|contacts/.test(invText), 'inventaire doit lister des tables connues')
    assert.ok(/airtable|quickbooks|hubspot/i.test(invText), 'inventaire doit lister des connecteurs')

    // Retour sur la carte : navigation réelle vers une page via la carte.
    await page.click('[data-testid="arch-tab-map"]')
    await contactsLink.first().click()
    await page.waitForURL(u => u.toString().includes('/contacts'), { timeout: 10000 })
    assert.ok(page.url().includes('/contacts'), 'clic sur une feuille doit naviguer vers la page')
  })
})
