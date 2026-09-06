const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie les raccourcis clavier globaux ajoutés au Layout :
// t = feuille-de-temps, b = tickets, p = pipeline (Projets), c = orders.
// Les raccourcis ne doivent pas se déclencher quand on tape dans un input.
describe('Layout — raccourcis clavier de navigation', () => {
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

  async function pressAndCheck(key, expectedPath) {
    // Navigate somewhere else first if we're testing the shortcut to the current page
    const startPath = expectedPath === '/dashboard' ? '/tickets' : '/dashboard'
    await page.goto(`${URL}${startPath}`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle')
    // S'assurer qu'aucun input n'a le focus
    await page.evaluate(() => document.activeElement?.blur())
    await page.keyboard.press(key)
    await page.waitForURL(u => u.toString().endsWith(expectedPath), { timeout: 5000 })
    assert.ok(page.url().endsWith(expectedPath), `Attendu ${expectedPath}, vu ${page.url()}`)
  }

  test('d → /dashboard', async () => { await pressAndCheck('d', '/dashboard') })
  test('t → /feuille-de-temps', async () => { await pressAndCheck('t', '/feuille-de-temps') })
  test('b → /tickets', async () => { await pressAndCheck('b', '/tickets') })
  test('p → /pipeline', async () => { await pressAndCheck('p', '/pipeline') })
  test('c → /orders', async () => { await pressAndCheck('c', '/orders') })

  test('un raccourci ne doit pas se déclencher quand un input a le focus', async () => {
    // /tickets contient une barre de recherche. On focus l'input et on tape
    // "tbpc" — aucun raccourci ne doit se déclencher.
    await page.goto(`${URL}/tickets`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle')
    const searchInput = page.locator('input[type="search"], input[placeholder*="Recherche" i]').first()
    await searchInput.waitFor({ state: 'visible', timeout: 5000 })
    await searchInput.click()
    await page.keyboard.type('tbpc')
    assert.ok(page.url().endsWith('/tickets'), `URL ne devrait pas changer, vu : ${page.url()}`)
    const val = await searchInput.inputValue()
    assert.equal(val, 'tbpc', `Le texte tapé doit aller dans l'input, vu : "${val}"`)
  })
})
