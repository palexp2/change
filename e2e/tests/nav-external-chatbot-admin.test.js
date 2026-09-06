const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const EXPECTED_HREF = 'https://customer.orisha.io/chatbot/admin'

describe('Nav — lien externe "Admin Chatbot"', () => {
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
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })
    // Le groupe « Autres outils » (qui porte le lien externe Admin Chatbot)
    // est replié par défaut : on le déplie comme le ferait l'utilisateur.
    await page.click('nav button:has-text("Autres outils")')
    await page.waitForSelector('[data-testid="nav-external"]', { timeout: 5000 })
  })

  after(async () => {
    await browser?.close()
  })

  test('le lien externe est rendu comme <a target="_blank"> avec le bon href', async () => {
    const link = page.locator('[data-testid="nav-external"]', { hasText: 'Admin Chatbot' })
    await link.waitFor({ state: 'visible', timeout: 5000 })

    const tag = await link.evaluate(el => el.tagName.toLowerCase())
    assert.equal(tag, 'a', 'le lien externe doit être une balise <a>')

    const href = await link.getAttribute('href')
    assert.equal(href, EXPECTED_HREF, `href attendu ${EXPECTED_HREF}, reçu ${href}`)

    const target = await link.getAttribute('target')
    assert.equal(target, '_blank', 'doit ouvrir dans un nouvel onglet (_blank)')

    const rel = await link.getAttribute('rel')
    assert.ok((rel || '').includes('noopener'), `rel doit inclure noopener, reçu ${rel}`)
  })

  test('le libellé "Admin Chatbot" est visible dans la sidebar', async () => {
    const link = page.locator('[data-testid="nav-external"]', { hasText: 'Admin Chatbot' })
    assert.equal(await link.count(), 1, 'un seul lien externe Admin Chatbot attendu')
    assert.ok(await link.isVisible(), 'le lien doit être visible')
  })
})
