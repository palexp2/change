const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS || 'saluerlessoviets'

describe('Dashboard — Projets créés par mois (YoY)', () => {
  let browser, ctx, page

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

  after(async () => { await browser?.close() })

  test('le widget s\'affiche avec barres et légende YoY', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })

    const card = page.locator('.card').filter({ has: page.locator('h2:has-text("Projets créés par mois")') })
    await card.waitFor({ state: 'visible', timeout: 8000 })

    const cardText = await card.innerText()
    const currYear = new Date().getFullYear()
    const prevYear = currYear - 1
    assert.ok(cardText.includes(String(currYear)), `Devrait mentionner ${currYear}. Reçu: ${cardText.slice(0, 200)}`)
    assert.ok(cardText.includes(String(prevYear)), `Devrait mentionner ${prevYear}. Reçu: ${cardText.slice(0, 200)}`)

    // 12 mois rendus
    const monthGroups = card.locator('[data-testid^="projects-created-month-"]')
    const count = await monthGroups.count()
    assert.equal(count, 12, `Devrait afficher 12 mois, reçu ${count}`)

    // Au moins une barre <rect> visible (autre que les hit areas transparentes)
    const visibleBars = await card.locator('svg rect[rx="2"]').count()
    assert.ok(visibleBars >= 1, `Devrait avoir au moins une barre rendue (rx=2). Reçu: ${visibleBars}`)
  })

  test('cliquer sur une barre navigue vers Pipeline avec le filtre du mois', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })

    const card = page.locator('.card').filter({ has: page.locator('h2:has-text("Projets créés par mois")') })
    await card.waitFor({ state: 'visible', timeout: 8000 })

    // Trouve la première barre cliquable (rx=2)
    const firstBar = card.locator('svg rect[rx="2"]').first()
    const hasBar = await firstBar.count()
    if (!hasBar) {
      // Pas de données — skip silencieusement
      return
    }

    await firstBar.click()
    await page.waitForURL(u => u.toString().includes('createdMonth='), { timeout: 5000 })

    const url = page.url()
    assert.match(url, /createdMonth=\d{4}-\d{2}/, `URL devrait contenir createdMonth=YYYY-MM. Reçu: ${url}`)

    // Bandeau de filtre visible
    await page.locator('text=/Projets créés en/').first().waitFor({ state: 'visible', timeout: 5000 })
  })
})
