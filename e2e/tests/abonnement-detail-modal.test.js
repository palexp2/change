// Vérifie que cliquer sur une ligne d'abonnement ouvre le modal de détail
// sans planter (régression : localAbo null causait "Cannot read properties
// of null (reading 'company_id')" et écran blanc).

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Abonnements — modal de détail', () => {
  let browser, ctx, page, pageErrors

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    pageErrors = []
    page.on('pageerror', err => pageErrors.push(err.message))
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => { await browser?.close() })

  test('cliquer une ligne ouvre le modal sans throw', async () => {
    await page.goto(`${URL}/abonnements`, { waitUntil: 'networkidle' })
    await page.waitForSelector('text=/\\d+\\s+lignes?/', { timeout: 10000 })

    pageErrors.length = 0

    // Trouver la première ligne ayant un lien company, puis cliquer à droite
    // du lien (sur la ligne elle-même, pas sur le lien) pour déclencher onRowClick.
    const link = page.locator('a[href*="/companies/"]').first()
    await link.waitFor({ state: 'visible', timeout: 5000 })
    const box = await link.boundingBox()
    assert.ok(box, 'lien company doit avoir une bounding box')
    await page.mouse.click(box.x + box.width + 200, box.y + box.height / 2)

    await page.waitForSelector('text=/Détails de l.abonnement/', { timeout: 5000 })

    // Aucune exception JS
    assert.equal(pageErrors.length, 0, `pageerror inattendue : ${pageErrors.join(' | ')}`)
  })

  test('le modal affiche le statut et les dates', async () => {
    // Le titre du modal
    await page.locator('text=/Détails de l.abonnement/').first().waitFor({ state: 'visible' })
    // Au moins un des labels statiques
    const startLabel = await page.locator('text=/^Début$/').count()
    assert.ok(startLabel > 0, 'le label "Début" doit être visible')
  })
})
