const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Drill-down : cliquer sur un point du graphique « Rentabilité des commandes »
// → tableau du bas filtré sur la fenêtre 28 jours se terminant à ce point,
// avec un bouton « Effacer le filtre ».
// Chaque point résume les commandes des 28 jours glissants se terminant à ce point.
// Le serveur charge 140 jours de commandes → cliquer un point ANCIEN (>28j) affiche
// désormais ses commandes au lieu d'un tableau vide.
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

    // Le header doit basculer en mode filtré (fenêtre 28 jours)
    const filteredHeader = await page.getByRole('button', { name: /Commandes — 28 jours au/ }).first().textContent()
    assert.match(filteredHeader, /Commandes — 28 jours au/, `header attendu en mode filtré, reçu: ${filteredHeader}`)

    // Effacer → header revient à l'original
    await clearBtn.click()
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="profitability-filter-clear"]'),
      { timeout: 3000 }
    )
    const restored = await page.getByRole('button', { name: /Commandes envoyées — 28 derniers jours/ }).first().textContent()
    assert.match(restored, /Commandes envoyées — 28 derniers jours/, `header attendu en mode non filtré, reçu: ${restored}`)
  })

  test('survol d\'un point → tooltip résume la fenêtre 28 jours ("28j au")', async () => {
    await page.goto(`${URL}/`, { waitUntil: 'networkidle' })

    await page.locator('[data-testid^="profitability-week-"]').first().waitFor({ state: 'attached', timeout: 10000 })
    const allKeys = await page.locator('[data-testid^="profitability-week-"]').evaluateAll(
      els => els.map(e => e.getAttribute('data-testid').replace('profitability-week-', ''))
    )
    if (!allKeys.length) return
    const recentKey = allKeys.sort().reverse()[0]
    const recentWeek = page.locator(`[data-testid="profitability-week-${recentKey}"]`)
    await recentWeek.scrollIntoViewIfNeeded()

    // Survol → le tooltip SVG apparaît avec l'entête « 28j au » (fenêtre glissante, pas une seule semaine)
    await recentWeek.locator('rect').hover()
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll('svg text')).some(t => /28j au/.test(t.textContent)),
      { timeout: 3000 }
    )
    const hasHeader = await page.evaluate(
      () => Array.from(document.querySelectorAll('svg text')).some(t => /28j au/.test(t.textContent))
    )
    assert.ok(hasHeader, 'le tooltip doit afficher « 28j au » (résumé 28 jours glissants)')
  })

  test('clic sur le point le plus ancien (>28j) → ses commandes s\'affichent', async () => {
    await page.goto(`${URL}/`, { waitUntil: 'networkidle' })

    // Le point rendu le plus ancien (les points sans marge sont omis).
    await page.locator('[data-testid^="profitability-week-"]').first().waitFor({ state: 'attached', timeout: 10000 })
    const allKeys = await page.locator('[data-testid^="profitability-week-"]').evaluateAll(
      els => els.map(e => e.getAttribute('data-testid').replace('profitability-week-', ''))
    )
    if (!allKeys.length) return
    const oldestKey = allKeys.sort()[0]

    // Ce test ne vaut que si le point est bien au-delà des 28 derniers jours :
    // c'est là que l'ancien comportement renvoyait un tableau vide.
    const ageDays = (Date.now() - new Date(oldestKey).getTime()) / 86400000
    if (ageDays <= 28) return

    const oldWeek = page.locator(`[data-testid="profitability-week-${oldestKey}"]`)
    await oldWeek.scrollIntoViewIfNeeded()
    await oldWeek.locator('rect').click()

    // Header en mode filtré.
    const clearBtn = page.locator('[data-testid="profitability-filter-clear"]')
    await clearBtn.waitFor({ timeout: 3000 })

    const table = page.locator('[data-testid="profitability-orders-table"]')
    await table.waitFor({ timeout: 3000 })

    // Un point rendu = des expéditions cette semaine-là → au moins une ligne de commande,
    // et plus jamais le message obsolète « au-delà de la fenêtre 28 jours ».
    const rowCount = await table.locator('tbody tr').count()
    const text = await table.textContent()
    assert.ok(!text.includes('au-delà de la fenêtre 28 jours'),
      `le message hors-fenêtre obsolète ne doit plus apparaître, reçu: ${text}`)
    assert.ok(rowCount >= 1 && !text.includes('Aucune commande'),
      `cliquer un point ancien doit afficher ses commandes, reçu ${rowCount} ligne(s): ${text}`)

    await clearBtn.click()
  })
})
