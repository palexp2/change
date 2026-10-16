const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Test lecture seule — aucun record créé, aucune préférence utilisateur écrite
// (la vue globale ne persiste rien).
describe('Dashboard — vue globale seule (planche façon Power BI)', () => {
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

  test('/dashboard n\'affiche que la vue globale, sans onglets ni sections', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'domcontentloaded' })
    await page.locator('[data-testid="dashboard-overview"]').waitFor({ timeout: 30000 })
    assert.equal(await page.locator('[data-testid="dashboard-tabs"]').count(), 0)
    assert.equal(await page.locator('[data-testid="dashboard-toc"]').count(), 0)
    assert.equal(await page.locator('[data-section-id]').count(), 0)
  })

  test('La vue globale montre le héros, les tuiles et les graphiques', async () => {
    const board = page.locator('[data-testid="dashboard-overview"]')
    await board.waitFor({ timeout: 20000 })

    // Bande héros : soit la trésorerie, soit un message d'erreur QuickBooks
    // explicite (QB peut être indisponible — on ne veut pas de page blanche).
    await page.locator('[data-testid="overview-hero"]').waitFor({ timeout: 10000 })
    await page.locator('[data-testid="overview-treasury"], [data-testid="overview-treasury-error"]')
      .first().waitFor({ timeout: 30000 })

    // Toutes les infos d'un coup d'œil : une bande d'indicateurs…
    const tiles = page.locator('[data-testid^="overview-tile-"]')
    assert.ok(await tiles.count() >= 6, `trop peu de tuiles d'indicateurs (${await tiles.count()})`)
    assert.match(await page.locator('[data-testid="overview-tile-projects"]').innerText(), /Projets créés/)
    // « Revenus expédiés » retirée à la demande de Pierre-Alexandre Papillon (2026-10-02).
    assert.equal(await page.locator('[data-testid="overview-tile-revenue"]').count(), 0)

    // …et une planche de graphiques compacts.
    const charts = page.locator('[data-testid^="overview-chart-"]:not([data-testid*="toggle"]):not([data-testid*="table"])')
    assert.ok(await charts.count() >= 7, `trop peu de graphiques (${await charts.count()})`)

    // Les tableaux de synthèse sont là aussi.
    await page.locator('[data-testid="overview-bank-accounts"]').waitFor({ timeout: 10000 })
    await page.locator('[data-testid="overview-aging"]').waitFor({ timeout: 10000 })
  })

  test('Les cartes graphiques n\'offrent plus de bascule en tableau', async () => {
    await page.locator('[data-testid="overview-chart-projects"]').waitFor({ timeout: 10000 })
    assert.equal(await page.locator('[data-testid^="overview-chart-toggle-"]').count(), 0)
  })

  test('Les anciens liens /dashboard/<section> ouvrent la vue globale', async () => {
    for (const slug of ['vue-globale', 'taux-de-remplacement']) {
      await page.goto(URL + '/dashboard/' + slug, { waitUntil: 'domcontentloaded' })
      await page.locator('[data-testid="dashboard-overview"]').waitFor({ timeout: 30000 })
    }
  })
})
