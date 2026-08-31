const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Test lecture seule — aucun record créé, aucune préférence utilisateur écrite
// (l'onglet « Vue globale » ne persiste rien : ni prefs de sections, ni thème).
describe('Dashboard — onglet « Vue globale » (planche façon Power BI)', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 20000 })
  })

  after(async () => { await browser?.close() })

  test('Les deux onglets sont offerts et « Sections » est celui par défaut', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'domcontentloaded' })

    const sectionsTab = page.locator('[data-testid="dashboard-tab-sections"]')
    const overviewTab = page.locator('[data-testid="dashboard-tab-overview"]')
    await sectionsTab.waitFor({ timeout: 30000 })
    await overviewTab.waitFor({ timeout: 5000 })

    assert.equal(await sectionsTab.getAttribute('aria-selected'), 'true')
    assert.equal(await overviewTab.getAttribute('aria-selected'), 'false')

    // La vue classique (table des matières + sections) est bien celle affichée.
    await page.locator('[data-testid="dashboard-toc"]').waitFor({ timeout: 10000 })
    assert.equal(await page.locator('[data-testid="dashboard-overview"]').count(), 0)
  })

  test('L\'onglet « Vue globale » montre le héros, les tuiles et les graphiques', async () => {
    await page.locator('[data-testid="dashboard-tab-overview"]').click()
    await page.waitForURL(u => u.toString().includes('/dashboard/vue-globale'), { timeout: 10000 })

    const board = page.locator('[data-testid="dashboard-overview"]')
    await board.waitFor({ timeout: 20000 })
    assert.equal(await page.locator('[data-testid="dashboard-tab-overview"]').getAttribute('aria-selected'), 'true')

    // Bande héros : soit la trésorerie, soit un message d'erreur QuickBooks
    // explicite (QB peut être indisponible — on ne veut pas de page blanche).
    await page.locator('[data-testid="overview-hero"]').waitFor({ timeout: 10000 })
    await page.locator('[data-testid="overview-treasury"], [data-testid="overview-treasury-error"]')
      .first().waitFor({ timeout: 30000 })

    // Toutes les infos d'un coup d'œil : une douzaine d'indicateurs…
    const tiles = page.locator('[data-testid^="overview-tile-"]')
    assert.ok(await tiles.count() >= 10, `trop peu de tuiles d'indicateurs (${await tiles.count()})`)
    assert.match(await page.locator('[data-testid="overview-tile-revenue"]').innerText(), /Revenus expédiés/)

    // …et une planche de graphiques compacts.
    const charts = page.locator('[data-testid^="overview-chart-"]:not([data-testid*="toggle"]):not([data-testid*="table"])')
    assert.ok(await charts.count() >= 7, `trop peu de graphiques (${await charts.count()})`)

    // Les tableaux de synthèse sont là aussi.
    await page.locator('[data-testid="overview-bank-accounts"]').waitFor({ timeout: 10000 })
    await page.locator('[data-testid="overview-aging"]').waitFor({ timeout: 10000 })

    // La table des matières des sections n'a plus lieu d'être dans cette vue.
    assert.equal(await page.locator('[data-testid="dashboard-toc"]').count(), 0)
  })

  test('Chaque graphique se lit aussi en tableau', async () => {
    const toggle = page.locator('[data-testid="overview-chart-toggle-projects"]')
    const table = page.locator('[data-testid="overview-chart-table-projects"]')

    await toggle.scrollIntoViewIfNeeded()
    assert.equal(await table.count(), 0, 'le tableau devrait être masqué au départ')

    await toggle.click()
    await table.waitFor({ timeout: 5000 })
    assert.equal(await toggle.getAttribute('aria-pressed'), 'true')
    const rows = await table.locator('tbody tr').count()
    assert.ok(rows >= 6, `le tableau devrait lister les mois (lignes: ${rows})`)

    await toggle.click()
    await table.waitFor({ state: 'detached', timeout: 5000 })
    assert.equal(await toggle.getAttribute('aria-pressed'), 'false')
  })

  test('L\'URL /dashboard/vue-globale ouvre directement la planche', async () => {
    await page.goto(URL + '/dashboard/vue-globale', { waitUntil: 'domcontentloaded' })
    await page.locator('[data-testid="dashboard-overview"]').waitFor({ timeout: 30000 })
    assert.equal(await page.locator('[data-testid="dashboard-tab-overview"]').getAttribute('aria-selected'), 'true')
  })

  test('Le retour sur « Sections » rend la vue classique', async () => {
    await page.locator('[data-testid="dashboard-tab-sections"]').click()
    await page.locator('[data-testid="dashboard-toc"]').waitFor({ timeout: 15000 })
    assert.equal(await page.locator('[data-testid="dashboard-overview"]').count(), 0)
    await page.locator('[data-testid="section-bank-accounts"]').waitFor({ timeout: 10000 })
  })
})
