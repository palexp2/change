const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Drill-down : cliquer sur une semaine du graphique « Rentabilité des commandes »
// → tableau du bas filtré sur cette semaine, avec un bouton « Effacer le filtre ».
// Note : le tableau du bas couvre seulement les 28 derniers jours, donc une semaine
// hors fenêtre rendra un tableau vide avec un message explicatif.
describe('Dashboard — drill-down "Rentabilité des commandes"', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({
      viewport: { width: 1400, height: 900 },
      timezoneId: 'America/Montreal',
    })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => { await browser?.close() })

  // Calcule la clé ISO d'un lundi à partir d'une date locale (mêmes règles que le composant).
  function mondayKey(date) {
    const d = new Date(date)
    const day = d.getDay()
    const monday = new Date(d)
    monday.setDate(d.getDate() - ((day + 6) % 7))
    monday.setHours(0, 0, 0, 0)
    return monday.toISOString().slice(0, 10)
  }

  test('clic sur une semaine récente → header filtré ; "Effacer" rétablit', async () => {
    await page.goto(`${URL}/`, { waitUntil: 'networkidle' })

    // Récupère toutes les semaines rendues (les semaines sans marge sont omises)
    // et prend la plus récente (plus grande clé ISO).
    await page.locator('[data-testid^="profitability-week-"]').first().waitFor({ state: 'attached', timeout: 10000 })
    const allKeys = await page.locator('[data-testid^="profitability-week-"]').evaluateAll(
      els => els.map(e => e.getAttribute('data-testid').replace('profitability-week-', ''))
    )
    if (!allKeys.length) {
      // Pas de données → on ne peut pas tester
      return
    }
    const recentKey = allKeys.sort().reverse()[0]
    const recentWeek = page.locator(`[data-testid="profitability-week-${recentKey}"]`)
    await recentWeek.scrollIntoViewIfNeeded()

    // Clic : le tableau s'auto-déploie et le filtre s'applique.
    await recentWeek.locator('rect').click()

    // Le bouton « Effacer le filtre » apparaît
    const clearBtn = page.locator('[data-testid="profitability-filter-clear"]')
    await clearBtn.waitFor({ timeout: 3000 })

    // Le header doit basculer en mode filtré
    const filteredHeader = await page.getByRole('button', { name: /Commandes — semaine du/ }).first().textContent()
    assert.match(filteredHeader, /Commandes — semaine du/, `header attendu en mode filtré, reçu: ${filteredHeader}`)

    // Effacer → header revient à l'original
    await clearBtn.click()
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="profitability-filter-clear"]'),
      { timeout: 3000 }
    )
    const restored = await page.getByRole('button', { name: /Commandes envoyées — 28 derniers jours/ }).first().textContent()
    assert.match(restored, /Commandes envoyées — 28 derniers jours/, `header attendu en mode non filtré, reçu: ${restored}`)
  })

  test('clic sur une semaine ancienne (>28j) → tableau vide avec message hors-fenêtre', async () => {
    await page.goto(`${URL}/`, { waitUntil: 'networkidle' })

    // Semaine 15 fois reculée = la plus ancienne du graphique (16 semaines au total).
    const old = new Date()
    old.setDate(old.getDate() - 15 * 7)
    const oldKey = mondayKey(old)
    const oldWeek = page.locator(`[data-testid="profitability-week-${oldKey}"]`)
    await oldWeek.waitFor({ state: 'attached', timeout: 10000 })
    await oldWeek.scrollIntoViewIfNeeded()
    await oldWeek.locator('rect').click()

    const table = page.locator('[data-testid="profitability-orders-table"]')
    await table.waitFor({ timeout: 3000 })
    const text = await table.textContent()
    assert.ok(
      text.includes('Aucune commande envoyée la semaine du') && text.includes('au-delà de la fenêtre 28 jours'),
      `tableau vide doit indiquer la semaine hors fenêtre, reçu: ${text}`
    )

    await page.locator('[data-testid="profitability-filter-clear"]').click()
  })
})
