const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('DataTable — scroll horizontal avec toutes les colonnes visibles', () => {
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

  test('Tout voir → le container scrolle horizontalement et header reste aligné', async () => {
    await page.goto(URL + '/orders', { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(800)

    // Ouvrir le panneau Champs et forcer l'état "toutes visibles" (clic Tout cacher
    // puis Tout voir — idempotent même si la vue était déjà complètement affichée)
    await page.locator('button', { hasText: /^Champs/ }).first().click()
    const hideBtn = page.locator('button', { hasText: /^Tout cacher$/ })
    if (await hideBtn.isEnabled()) await hideBtn.click()
    await page.waitForTimeout(150)
    await page.locator('button', { hasText: /^Tout voir$/ }).click()
    await page.waitForTimeout(300)
    // Fermer le panneau
    await page.keyboard.press('Escape').catch(() => {})
    await page.mouse.click(10, 10)
    await page.waitForTimeout(200)

    // Vérifier que le container de scroll a une largeur de contenu supérieure au viewport
    const metrics = await page.evaluate(() => {
      // Le container de scroll a overflow-auto + style height
      const candidates = document.querySelectorAll('div.overflow-auto')
      for (const el of candidates) {
        if (el.scrollWidth > el.clientWidth + 10) {
          return {
            scrollWidth: el.scrollWidth,
            clientWidth: el.clientWidth,
            scrollLeftBefore: el.scrollLeft,
          }
        }
      }
      return null
    })
    assert.ok(metrics, 'au moins un container doit scroller horizontalement (scrollWidth > clientWidth)')
    assert.ok(
      metrics.scrollWidth > metrics.clientWidth + 100,
      `scrollWidth (${metrics.scrollWidth}) doit dépasser clientWidth (${metrics.clientWidth})`
    )

    // Scroller horizontalement et vérifier que le header suit (même grid template)
    const aligned = await page.evaluate(() => {
      const container = [...document.querySelectorAll('div.overflow-auto')]
        .find(el => el.scrollWidth > el.clientWidth + 10)
      if (!container) return { ok: false, reason: 'no scroll container' }
      container.scrollLeft = 400

      // Trouver le header grid (sticky) et la première ligne du body
      const grids = container.querySelectorAll('[style*="grid-template-columns"]')
      if (grids.length < 2) return { ok: false, reason: `only ${grids.length} grids` }
      const headerRect = grids[0].getBoundingClientRect()
      const firstRowRect = grids[1].getBoundingClientRect()
      return {
        ok: true,
        headerLeft: headerRect.left,
        firstRowLeft: firstRowRect.left,
        delta: Math.abs(headerRect.left - firstRowRect.left),
        scrollLeft: container.scrollLeft,
      }
    })
    assert.ok(aligned.ok, `test alignement header/body: ${aligned.reason}`)
    assert.ok(aligned.scrollLeft > 0, `scrollLeft=${aligned.scrollLeft} devrait être > 0 après scroll`)
    assert.ok(
      aligned.delta < 2,
      `header et body doivent s'aligner horizontalement (delta=${aligned.delta}px, headerLeft=${aligned.headerLeft}, firstRowLeft=${aligned.firstRowLeft})`
    )
  })
})
