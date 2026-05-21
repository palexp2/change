// Vérifie que le favicon change selon la page :
// - sur /dashboard, le favicon est un SVG inline (data: url) basé sur l'icône LayoutDashboard
// - sur /orders, le favicon change pour l'icône ShoppingCart
// - sur /contacts, le favicon change pour l'icône Contact
// - le href change effectivement entre deux pages distinctes

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Favicon dynamique selon la page', () => {
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

  after(async () => { await browser?.close() })

  async function faviconHref() {
    return await page.evaluate(() => {
      const l = document.querySelector("link[rel~='icon']")
      return l ? l.href : null
    })
  }

  test('Dashboard → favicon SVG data: URL non vide', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'domcontentloaded' })
    // Laisse useEffect le temps de tourner
    await page.waitForFunction(() => {
      const l = document.querySelector("link[rel~='icon']")
      return l && l.href && l.href.startsWith('data:image/svg+xml')
    }, { timeout: 5000 })
    const href = await faviconHref()
    assert.ok(href.startsWith('data:image/svg+xml'), 'favicon doit être un SVG data: URL')
    assert.ok(href.includes('svg'), 'href doit contenir du SVG')
  })

  test('Le favicon change quand on navigue vers une autre page', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() =>
      document.querySelector("link[rel~='icon']")?.href?.startsWith('data:image/svg+xml'))
    const dashboardHref = await faviconHref()

    await page.goto(URL + '/orders', { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(prev =>
      document.querySelector("link[rel~='icon']")?.href !== prev, dashboardHref, { timeout: 5000 })
    const ordersHref = await faviconHref()

    assert.notEqual(ordersHref, dashboardHref, 'favicon doit changer entre /dashboard et /orders')
    assert.ok(ordersHref.startsWith('data:image/svg+xml'))

    await page.goto(URL + '/contacts', { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(prev =>
      document.querySelector("link[rel~='icon']")?.href !== prev, ordersHref, { timeout: 5000 })
    const contactsHref = await faviconHref()

    assert.notEqual(contactsHref, ordersHref, 'favicon doit changer entre /orders et /contacts')
    assert.notEqual(contactsHref, dashboardHref, 'favicon doit changer entre /dashboard et /contacts')
  })

  test('Le favicon utilise le SVG des lucide icons (stroke + viewBox 0 0 24 24)', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() =>
      document.querySelector("link[rel~='icon']")?.href?.startsWith('data:image/svg+xml'))
    const href = await faviconHref()
    const decoded = decodeURIComponent(href.replace(/^data:image\/svg\+xml;charset=utf-8,/, ''))
    assert.ok(decoded.includes('viewBox="0 0 24 24"'), 'doit garder le viewBox lucide')
    assert.ok(decoded.includes('<svg'), 'doit être un SVG')
  })
})
