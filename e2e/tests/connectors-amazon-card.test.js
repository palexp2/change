const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Lecture seule : on ne crée ni ne mute aucun record/config — juste la présence
// de la nouvelle carte connecteur « Amazon Business » sur la page Connecteurs.
// Pas de cleanup nécessaire (cf. CLAUDE.md : préfixe identifiable / restauration
// ne s'appliquent qu'aux créations/mutations).
describe('Connecteur Amazon Business — carte présente', () => {
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

  test('la carte "Amazon Business" s\'affiche dans Connecteurs', async () => {
    await page.goto(`${URL}/connectors`, { waitUntil: 'networkidle' })
    const card = page.locator('text=Amazon Business').first()
    await card.waitFor({ state: 'visible', timeout: 8000 })
    assert.ok(await card.isVisible(), 'La carte Amazon Business doit être visible')
  })
})
