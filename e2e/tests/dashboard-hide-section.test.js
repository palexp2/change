const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS || 'saluerlessoviets'

describe('Dashboard — bouton masquer sur les fiches', () => {
  let browser, ctx, page

  const clearPrefs = () => page.evaluate(() => {
    Object.keys(localStorage).filter(k => k.startsWith('dashboard_prefs_')).forEach(k => localStorage.removeItem(k))
  })

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => {
    // Cleanup : remet les prefs par défaut (tout visible) pour ne pas laisser
    // de fiche masquée derrière le test.
    try { await clearPrefs() } catch {}
    await browser?.close()
  })

  test('le bouton hide masque la fiche, le toast Annuler la restaure', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })
    await clearPrefs()
    await page.reload({ waitUntil: 'networkidle' })

    const sectionId = 'section_subscription_events'
    const card = page.locator(`[data-section-id="${sectionId}"]`)
    await card.waitFor({ state: 'visible', timeout: 8000 })

    // Chaque fiche expose un bouton hide en haut à droite
    const hideBtn = page.locator(`[data-testid="section-hide-${sectionId}"]`)
    assert.ok(await hideBtn.isVisible(), 'Le bouton masquer devrait être visible sur la fiche')

    await hideBtn.click()

    // La fiche disparaît du dashboard
    await card.waitFor({ state: 'detached', timeout: 5000 })

    // Un toast confirme avec une action Annuler
    const undoBtn = page.locator('button:has-text("Annuler")')
    await undoBtn.waitFor({ state: 'visible', timeout: 5000 })
    await undoBtn.click()

    // La fiche réapparaît
    await page.locator(`[data-section-id="${sectionId}"]`).waitFor({ state: 'visible', timeout: 5000 })
  })

  test('la fiche masquée reste masquée après rechargement et se réactive via Personnaliser', async () => {
    const sectionId = 'section_replacement_rate'
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })
    const card = page.locator(`[data-section-id="${sectionId}"]`)
    await card.waitFor({ state: 'visible', timeout: 8000 })

    await page.locator(`[data-testid="section-hide-${sectionId}"]`).click()
    await card.waitFor({ state: 'detached', timeout: 5000 })

    // Persistance après reload
    await page.reload({ waitUntil: 'networkidle' })
    await page.locator('[data-section-id]').first().waitFor({ state: 'visible', timeout: 8000 })
    assert.equal(
      await page.locator(`[data-section-id="${sectionId}"]`).count(),
      0,
      'La fiche masquée devrait rester masquée après rechargement'
    )

    // Réactivation via le panneau Personnaliser (case à cocher)
    await page.click('button:has-text("Personnaliser")')
    const row = page.locator(`[data-testid="dashboard-editor-row-${sectionId}"]`)
    await row.waitFor({ state: 'visible', timeout: 5000 })
    const checkbox = row.locator('input[type="checkbox"]')
    assert.equal(await checkbox.isChecked(), false, 'La case devrait être décochée après le hide')
    await checkbox.click()
    await page.locator(`[data-section-id="${sectionId}"]`).waitFor({ state: 'visible', timeout: 5000 })
  })
})
