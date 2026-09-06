// La fiche détail commande (vue commerciale) doit occuper toute la largeur
// disponible, plus de conteneur `max-w-5xl mx-auto` qui la centrait avec de
// grandes marges vides sur les écrans larges.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const ORDER_ID = '3f1221bd-714f-4b48-9f3a-751072d4a464'
const VIEWPORT_WIDTH = 1600

async function login(page) {
  await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASS)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
}

describe('OrderDetail — fiche commande en pleine largeur', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: VIEWPORT_WIDTH, height: 900 } })
    page = await ctx.newPage()
    await login(page)
  })

  after(async () => { await browser?.close() })

  test('le conteneur principal de la fiche commande n\'est pas limité par un max-width centré', async () => {
    await page.goto(`${URL}/orders/${ORDER_ID}`, { waitUntil: 'networkidle' })

    // Wait for the header "Créée le ..." so we know the commercial view is rendered.
    await page.locator('text=/Créée le /').first().waitFor({ state: 'visible', timeout: 10000 })

    const heading = page.locator('h1:has-text("Commande #")').first()
    await heading.waitFor({ state: 'visible', timeout: 10000 })

    // The commercial-view wrapper is the ancestor <div class="p-6"> right under <main>.
    const containerBox = await page.evaluate(() => {
      const main = document.querySelector('main')
      const container = main?.firstElementChild
      if (!container) return null
      const rect = container.getBoundingClientRect()
      return { width: rect.width, className: container.className }
    })

    assert.ok(containerBox, 'conteneur principal introuvable sous <main>')
    assert.ok(
      !/max-w-5xl/.test(containerBox.className),
      `le conteneur ne devrait plus avoir max-w-5xl, classes actuelles: ${containerBox.className}`
    )

    // Old constraint was max-w-5xl (64rem = 1024px). At a 1600px viewport the
    // container should now stretch well beyond that, close to the full <main> width.
    assert.ok(
      containerBox.width > 1200,
      `attendu une largeur > 1200px à un viewport de ${VIEWPORT_WIDTH}px, obtenu ${containerBox.width}px`
    )
  })
})
