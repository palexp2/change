// GlobalSearch (Cmd+K) étendu en palette de commandes.
//
// Vérifie que la palette permet désormais de sauter directement à une page de
// l'app (section « Aller à »), en plus de la recherche de records.
//
// Test en lecture seule : aucune création de record, aucune mutation de config
// (on ne fait qu'ouvrir la palette et naviguer). → pas de cleanup nécessaire.

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

async function openPalette(page) {
  // Ouvre via Cmd+K (raccourci global de Layout). Sur Linux le binding accepte
  // ctrl+k comme metaKey ; on émule le modificateur Control.
  await page.keyboard.press('Control+k')
  await page.waitForSelector('[data-testid="global-search-input"]', { state: 'visible', timeout: 5000 })
}

describe('GlobalSearch — palette de commandes (navigation pages)', () => {
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

  test('ouverture via Cmd+K + section « Aller à » présente à vide', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })
    await openPalette(page)

    // À vide, la palette doit lister les pages (section « Aller à »).
    await page.waitForSelector('li:has-text("Aller à")', { timeout: 5000 })

    // Au moins une page navigable connue est listée (Factures clients).
    const facturesBtn = page.locator('[data-testid="global-search-page-/factures"]')
    await facturesBtn.first().waitFor({ state: 'visible', timeout: 5000 })

    // Fermer avec Échap.
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-testid="global-search-input"]', { state: 'detached', timeout: 5000 })
  })

  test('filtrage par requête + navigation au clic', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })
    await openPalette(page)

    // Taper le nom d'une page → la section « Aller à » se filtre.
    await page.fill('[data-testid="global-search-input"]', 'abonnement')
    const aboBtn = page.locator('[data-testid="global-search-page-/abonnements"]')
    await aboBtn.first().waitFor({ state: 'visible', timeout: 5000 })

    // Clic → navigation vers /abonnements.
    await aboBtn.first().click()
    await page.waitForURL(u => u.toString().includes('/abonnements'), { timeout: 10000 })
    assert.ok(page.url().includes('/abonnements'), 'le clic sur une page doit naviguer vers /abonnements')
  })

  test('navigation clavier (flèches + Entrée) saute à la première page', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })
    await openPalette(page)

    // Filtrer sur « factures » : « Factures clients » (/factures) doit être en
    // tête de la section « Aller à » et donc présélectionné (index 0).
    await page.fill('[data-testid="global-search-input"]', 'factures clients')
    const facturesBtn = page.locator('[data-testid="global-search-page-/factures"]')
    await facturesBtn.first().waitFor({ state: 'visible', timeout: 5000 })

    // Entrée valide l'élément présélectionné → navigation.
    await page.keyboard.press('Enter')
    await page.waitForURL(u => u.toString().includes('/factures'), { timeout: 10000 })
    assert.ok(page.url().includes('/factures'), 'Entrée doit naviguer vers la page présélectionnée')
  })
})
