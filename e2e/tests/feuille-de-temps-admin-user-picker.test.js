const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie que les admins peuvent consulter la feuille de temps d'un autre employé
// via le sélecteur d'utilisateur dans le header. Utilise les données importées
// d'Airtable (Martin Audesse, qui a 40 jours sur 2026-02-05 → 2026-05-04).
describe('Feuille de temps — sélecteur admin pour consulter un autre user', () => {
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

  after(async () => {
    await browser?.close()
  })

  test('le sélecteur user apparaît pour un admin', async () => {
    await page.goto(URL + '/feuille-de-temps', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('h1:has-text("Feuille de temps")')
    const picker = await page.locator('[data-testid="user-picker"]').count()
    assert.equal(picker, 1, 'le sélecteur d\'employé doit être visible pour un admin')
  })

  test('par défaut, on visualise sa propre feuille (pas de bandeau)', async () => {
    const banner = await page.locator('[data-testid="viewing-other-banner"]').count()
    assert.equal(banner, 0, 'pas de bandeau "feuille d\'un autre user" au départ')
  })

  test('sélectionner Martin Audesse charge ses feuilles importées', async () => {
    // Le RefPicker rend la popup via createPortal dans document.body — les inputs/boutons
    // ne sont donc pas dans l'arbre DOM du data-testid="user-picker", il faut les cibler globalement.
    await page.locator('[data-testid="user-picker"] button').click()
    await page.fill('input[placeholder="Rechercher…"]', 'Martin')
    await page.locator('button:has-text("Martin Audesse")').first().click()

    // Bandeau visible avec le nom
    await page.waitForSelector('[data-testid="viewing-other-banner"]', { timeout: 3000 })
    const bannerText = await page.locator('[data-testid="viewing-other-banner"]').innerText()
    assert.ok(bannerText.includes('Martin Audesse'), 'bandeau doit nommer Martin Audesse')

    // L'historique se recharge — on doit voir des lignes sur 2026-02 (40 jours importés pour Martin)
    await page.waitForFunction(() => {
      return document.querySelectorAll('[data-testid^="history-day-row-2026-02"]').length > 0
    }, { timeout: 5000 })
    const feb2026Rows = await page.locator('[data-testid^="history-day-row-2026-02"]').count()
    assert.ok(feb2026Rows > 0, `Martin doit avoir des feuilles sur 2026-02 (vu : ${feb2026Rows})`)
  })

  test('cliquer sur "Revenir à ma feuille" revient à l\'utilisateur connecté', async () => {
    await page.locator('[data-testid="viewing-other-banner"] button:has-text("Revenir à ma feuille")').click()
    await page.waitForSelector('[data-testid="viewing-other-banner"]', { state: 'detached', timeout: 3000 })
    const banner = await page.locator('[data-testid="viewing-other-banner"]').count()
    assert.equal(banner, 0, 'le bandeau disparaît après retour à sa propre feuille')
  })
})
