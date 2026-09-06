const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS || 'saluerlessoviets'

// Entreprise réelle avec permission fournaise (maxNumberOfHeaters > 0) sur ses
// contrôleurs centraux opérationnels ET des modules d'activation V1 en service.
const COMPANY_WITH_ALERT = '6cf9c1fe-6b51-4bd1-a809-8bd25e73148f' // Les serres de la presque Ile
// Entreprise avec permission fournaise mais aucun module d'activation V1.
const COMPANY_WITHOUT_ALERT = '06122a14-a04f-4469-aed7-b117f5a715b7' // Ferme la rosée du matin

// Test en lecture seule : aucune écriture, donc aucun nettoyage de record.
describe('Fiche entreprise — alerte fournaise + module d’activation V1', () => {
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

  after(async () => {
    await browser?.close()
  })

  test('l’alerte s’affiche quand permission fournaise + module V1', async () => {
    await page.goto(`${URL}/companies/${COMPANY_WITH_ALERT}`, { waitUntil: 'networkidle' })

    const alert = page.locator('[data-testid="furnace-v1-alert"]')
    await alert.waitFor({ state: 'visible', timeout: 15000 })

    const txt = await alert.innerText()
    assert.match(txt, /fournaise/i, 'L’alerte devrait mentionner la fournaise')
    assert.match(txt, /V1/, 'L’alerte devrait mentionner le module d’activation V1')

    // Les numéros de série listés sont cliquables vers la fiche du série
    const serialLinks = alert.locator('a[href*="/serials/"]')
    assert.ok(await serialLinks.count() > 0, 'L’alerte devrait lister au moins un module V1')
  })

  test('pas d’alerte quand l’entreprise n’a pas de module V1', async () => {
    await page.goto(`${URL}/companies/${COMPANY_WITHOUT_ALERT}`, { waitUntil: 'networkidle' })

    // La fiche est bien chargée (la nav de sections est rendue)
    await page.locator('[data-testid="company-section-nav"]').waitFor({ state: 'visible', timeout: 15000 })

    assert.equal(
      await page.locator('[data-testid="furnace-v1-alert"]').count(),
      0,
      'Aucune alerte ne devrait apparaître sans module d’activation V1'
    )
  })
})
