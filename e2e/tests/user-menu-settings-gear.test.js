const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Menu avatar (coin bas de la sidebar) : une roue « Paramètres » a été ajoutée
// juste AU-DESSUS de « Déconnexion ». Elle mène à la page d'upload de médias
// (/public-files). Test 100 % lecture/navigation — ne crée aucun record.
describe('Menu avatar — roue Paramètres au-dessus de Déconnexion', () => {
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

  test('le survol de l\'avatar révèle « Paramètres » au-dessus de « Déconnexion »', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="user-avatar-trigger"]', { timeout: 15000 })
    await page.hover('[data-testid="user-avatar-trigger"]')

    const settings = page.locator('[data-testid="user-menu-settings"]')
    await settings.waitFor({ state: 'visible', timeout: 5000 })
    assert.match(await settings.innerText(), /Paramètres/)

    // Ordre : la roue Paramètres est au-dessus du bouton Déconnexion.
    const logout = page.locator('button:has-text("Déconnexion")')
    const bs = await settings.boundingBox()
    const bl = await logout.boundingBox()
    assert.ok(bs.y < bl.y, `Paramètres au-dessus de Déconnexion (${bs.y} < ${bl.y})`)
  })

  test('cliquer « Paramètres » mène à la page d\'upload de médias', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="user-avatar-trigger"]', { timeout: 15000 })
    await page.hover('[data-testid="user-avatar-trigger"]')
    await page.locator('[data-testid="user-menu-settings"]').click()

    await page.waitForURL(u => u.toString().includes('/public-files'), { timeout: 10000 })
    // La zone d'upload de médias est présente sur la page cible.
    // L'input file est volontairement caché (class="hidden") → attendre l'attachement.
    await page.waitForSelector('[data-testid="public-files-input"]', { state: 'attached', timeout: 15000 })
    assert.equal(await page.locator('h1:has-text("Fichiers publics")').count(), 1)
  })
})
