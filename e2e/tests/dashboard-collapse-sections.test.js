const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS || 'saluerlessoviets'

describe('Dashboard — sections collapsibles', () => {
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

  test('un clic sur le chevron replie la section, un second la déplie', async () => {
    // Reset l'état persisté pour partir d'une page propre
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })
    await page.evaluate(() => {
      Object.keys(localStorage).filter(k => k.startsWith('dashboard_collapsed_')).forEach(k => localStorage.removeItem(k))
    })
    await page.reload({ waitUntil: 'networkidle' })

    const sectionId = 'section_stripe_subscriptions'
    const card = page.locator(`[data-section-id="${sectionId}"]`)
    await card.waitFor({ state: 'visible', timeout: 8000 })

    // Le titre doit toujours être là
    const title = card.locator('h2')
    assert.ok(await title.isVisible(), 'Le titre devrait être visible avant repli')

    // Le contenu (graphique) doit être visible avant le repli
    const chartBefore = card.locator('[data-testid^="stripe-revenue-month-"]').first()
    await chartBefore.waitFor({ state: 'visible', timeout: 5000 })

    // Clique sur le chevron pour replier
    const toggle = page.locator(`[data-testid="section-toggle-${sectionId}"]`)
    await toggle.click()

    // Le titre reste, le contenu disparaît
    assert.ok(await title.isVisible(), 'Le titre devrait rester visible une fois replié')
    const chartCount = await card.locator('[data-testid^="stripe-revenue-month-"]').count()
    assert.equal(chartCount, 0, `Le contenu devrait être caché après repli, ${chartCount} mois trouvés`)

    // aria-expanded doit refléter l'état
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false', 'aria-expanded devrait être false une fois replié')

    // Clique à nouveau pour déplier
    await toggle.click()
    await card.locator('[data-testid^="stripe-revenue-month-"]').first().waitFor({ state: 'visible', timeout: 5000 })
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true', 'aria-expanded devrait être true une fois déplié')
  })

  test('l\'état replié persiste après rechargement', async () => {
    const sectionId = 'section_stripe_sales'
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })
    const card = page.locator(`[data-section-id="${sectionId}"]`)
    await card.waitFor({ state: 'visible', timeout: 8000 })

    const toggle = page.locator(`[data-testid="section-toggle-${sectionId}"]`)
    await toggle.click()
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false')

    // Recharge la page
    await page.reload({ waitUntil: 'networkidle' })
    const toggleAfter = page.locator(`[data-testid="section-toggle-${sectionId}"]`)
    await toggleAfter.waitFor({ state: 'visible', timeout: 8000 })
    assert.equal(
      await toggleAfter.getAttribute('aria-expanded'),
      'false',
      'L\'état replié devrait persister après rechargement'
    )

    // Le contenu (graphique) doit rester caché
    const cardAfter = page.locator(`[data-section-id="${sectionId}"]`)
    const chartCount = await cardAfter.locator('[data-testid^="stripe-revenue-month-"]').count()
    assert.equal(chartCount, 0, 'Le contenu devrait rester caché après reload')

    // Cleanup : remet l'état déplié pour ne pas perturber les autres tests
    await toggleAfter.click()
  })
})
