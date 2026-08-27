const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Mode nuit — bouton soleil/lune dans l'en-tête de la sidebar.
// Le thème est une préférence purement locale (localStorage `erp.theme`) :
// aucun record créé côté serveur, rien à nettoyer en DB. Le contexte
// navigateur est jeté à la fin, donc la préférence disparaît avec lui.
describe('Mode nuit', () => {
  let browser, ctx, page

  const toggle = () => page.locator('[data-testid="app-sidebar"] [data-testid="theme-toggle"]')
  const htmlIsDark = () => page.evaluate(() => document.documentElement.classList.contains('dark'))
  const bodyBg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor)

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({
      viewport: { width: 1400, height: 900 },
      colorScheme: 'light', // état de départ déterministe (pas de préférence système sombre)
    })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
    await page.waitForSelector('[data-testid="app-sidebar"]', { timeout: 15000 })
  })

  after(async () => {
    // Préférence locale uniquement : on remet le mode jour par politesse
    // au cas où le contexte serait réutilisé, puis on ferme.
    try { await page.evaluate(() => localStorage.removeItem('erp.theme')) } catch {}
    await browser?.close()
  })

  test('le bouton est visible dans la sidebar et bascule en mode nuit', async () => {
    await toggle().waitFor({ state: 'visible', timeout: 10000 })
    assert.equal(await htmlIsDark(), false, 'devrait démarrer en mode jour')
    const lightBg = await bodyBg()

    await toggle().click()
    await page.waitForFunction(() => document.documentElement.classList.contains('dark'), null, { timeout: 5000 })

    const darkBg = await bodyBg()
    assert.notEqual(darkBg, lightBg, 'le fond de page doit changer')
    // Le fond nuit doit être réellement sombre (luminance faible).
    const [r, g, b] = darkBg.match(/\d+/g).map(Number)
    const lum = 0.299 * r + 0.587 * g + 0.114 * b
    assert.ok(lum < 60, `fond nuit trop clair: ${darkBg}`)
  })

  test('les surfaces et le texte suivent le thème', async () => {
    // La sidebar (bg-white) doit devenir sombre, et le texte clair.
    const sidebar = page.locator('[data-testid="app-sidebar"]')
    const bg = await sidebar.evaluate(el => getComputedStyle(el).backgroundColor)
    const [r, g, b] = bg.match(/\d+/g).map(Number)
    assert.ok(0.299 * r + 0.587 * g + 0.114 * b < 70, `sidebar pas sombre: ${bg}`)

    const titleColor = await page.locator('[data-testid="app-sidebar"] span:has-text("Orisha")').first()
      .evaluate(el => getComputedStyle(el).color)
    const [tr, tg, tb] = titleColor.match(/\d+/g).map(Number)
    assert.ok(0.299 * tr + 0.587 * tg + 0.114 * tb > 150, `texte pas clair: ${titleColor}`)
  })

  test('le choix persiste après un rechargement, sans flash blanc', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' })
    // La classe doit être posée avant le premier rendu (script inline).
    assert.equal(await htmlIsDark(), true, 'le mode nuit doit survivre au reload')
    await page.waitForSelector('[data-testid="app-sidebar"]', { timeout: 15000 })
    assert.equal(await toggle().getAttribute('data-theme'), 'dark')
  })

  test('le bouton revient au mode jour', async () => {
    await toggle().click()
    await page.waitForFunction(() => !document.documentElement.classList.contains('dark'), null, { timeout: 5000 })
    const bg = await bodyBg()
    const [r, g, b] = bg.match(/\d+/g).map(Number)
    assert.ok(0.299 * r + 0.587 * g + 0.114 * b > 200, `fond jour pas clair: ${bg}`)
    assert.equal(await page.evaluate(() => localStorage.getItem('erp.theme')), 'light')
  })
})
