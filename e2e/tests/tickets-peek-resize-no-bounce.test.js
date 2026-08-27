// Régression : redimensionner le side-peek (RecordPeekDrawer) sur /tickets ne
// doit pas rejouer l'animation d'entrée (slide-in) au relâchement de la
// poignée — sinon le panneau semble « rebondir ». Voir RecordPeekDrawer.jsx :
// la classe animate-slide-in-right ne doit s'appliquer qu'à l'ouverture
// initiale, pas à chaque fois que `resizing` repasse à false.
//
// Lecture seule : on n'édite aucun champ ni ne modifie de préférence
// persistée au-delà de la largeur du drawer (déjà couvert comme comportement
// normal ailleurs) ; rien à nettoyer.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Tickets — side-peek drawer, pas de rebond au redimensionnement', () => {
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

  test('relâcher la poignée de redimensionnement ne réapplique pas l\'animation de glissement', async () => {
    await page.goto(`${URL}/tickets`, { waitUntil: 'networkidle' })
    const firstRow = page.locator('[data-row-id]').first()
    await firstRow.waitFor({ timeout: 10000 })
    await firstRow.locator('.font-medium').first().click()

    const drawer = page.locator('[data-testid="record-peek-drawer"]')
    await drawer.waitFor({ timeout: 8000 })
    const panel = page.locator('[data-testid="record-peek-body"]').locator('xpath=..')

    // Laisse l'animation d'ouverture se terminer (0.2s) avant de tester.
    await page.waitForTimeout(400)
    assert.ok(
      !(await panel.evaluate((el) => el.className.includes('animate-slide-in-right'))),
      'animation d\'entrée terminée avant le drag'
    )

    const handle = page.locator('[data-testid="record-peek-resizer"]')
    const box = await handle.boundingBox()
    assert.ok(box, 'poignée de redimensionnement visible')

    const widthBefore = await panel.evaluate((el) => el.getBoundingClientRect().width)

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x - 120, box.y + box.height / 2, { steps: 10 })
    await page.mouse.up()

    const widthAfter = await panel.evaluate((el) => el.getBoundingClientRect().width)
    assert.ok(widthAfter > widthBefore, 'la largeur a bien changé pendant le drag')

    // Juste après le relâchement : la classe d'animation d'entrée ne doit pas
    // être réapparue (c'était le bug — elle rejouait le slide-in = rebond).
    const classAfterRelease = await panel.evaluate((el) => el.className)
    assert.ok(
      !classAfterRelease.includes('animate-slide-in-right'),
      `l'animation d'entrée ne doit pas être rejouée au relâchement (class=${classAfterRelease})`
    )

    // Le panneau reste bien ancré et stable après le relâchement (pas de saut).
    await page.waitForTimeout(250)
    const classSettled = await panel.evaluate((el) => el.className)
    assert.ok(
      !classSettled.includes('animate-slide-in-right'),
      `toujours pas d'animation rejouée après stabilisation (class=${classSettled})`
    )
  })
})
