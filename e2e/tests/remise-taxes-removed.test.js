// Remise TPS/TVQ — section RETIRÉE de l'interface à la demande de l'utilisateur
// (« ce n'est pas pertinent pour nous »). La page /remise-taxes avait été
// branchée sur le endpoint /api/reports/tax-remittance ; le endpoint serveur
// reste en place, mais plus rien ne doit y mener dans l'app : ni l'entrée du
// menu Espace finance, ni la route.
//
// Ce test garde la suppression : si l'entrée ou la route réapparaissent par
// accident (merge, restauration de fichier), il échoue.
//
// Lecture seule : aucun record créé, aucune configuration écrasée → pas de
// cleanup (le hook after() ne ferme que le navigateur).

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
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 20000 })
}

describe('Remise TPS/TVQ — section retirée de l\'interface', () => {
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

  test('le menu Espace finance n\'offre plus « Remise TPS/TVQ »', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('nav button:has-text("Comptabilité")', { timeout: 20000 })
    await page.click('nav button:has-text("Comptabilité")')
    await page.click('[data-testid="nav-flyout-trigger"]')
    const panel = page.locator('[data-testid="nav-flyout-panel"]')
    await panel.waitFor({ state: 'visible', timeout: 10000 })

    // Le panneau doit être rendu au complet (une entrée voisine du même groupe
    // en témoigne) mais sans l'entrée retirée.
    await panel.getByRole('link', { name: 'Écritures de fin de mois', exact: true }).waitFor({ state: 'visible', timeout: 10000 })
    assert.equal(
      await panel.getByRole('link', { name: 'Remise TPS/TVQ' }).count(),
      0,
      'l\'entrée « Remise TPS/TVQ » est encore dans le menu Espace finance',
    )
  })

  test('l\'URL /remise-taxes ne rend plus le rapport', async () => {
    await page.goto(URL + '/remise-taxes', { waitUntil: 'domcontentloaded' })
    // Route inconnue → catch-all de App.jsx → redirection hors de /remise-taxes.
    await page.waitForURL(u => !u.toString().includes('/remise-taxes'), { timeout: 15000 })
    assert.equal(
      await page.locator('h1:has-text("Remise TPS/TVQ")').count(),
      0,
      'la page Remise TPS/TVQ se rend encore',
    )
  })
})
