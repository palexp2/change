// Vérifie que la page /login affiche le logo Orisha et plus le placeholder vert.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'

describe('Login — logo Orisha', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('input[type="email"]', { timeout: 10000 })
  })

  after(async () => { await browser?.close() })

  test('le logo Orisha (img) est présent et chargé', async () => {
    const logo = page.locator('img[alt="Orisha"]')
    assert.equal(await logo.count(), 1, 'doit avoir exactement une img alt=Orisha')
    await logo.waitFor({ state: 'visible' })
    const naturalWidth = await logo.evaluate(el => el.naturalWidth)
    assert.ok(naturalWidth > 0, `le logo doit être chargé (naturalWidth=${naturalWidth})`)
  })

  test('le fichier /erp/orisha-logo.png répond 200', async () => {
    const resp = await page.request.get(URL + '/orisha-logo.png')
    assert.equal(resp.status(), 200, 'orisha-logo.png doit retourner 200')
    const ct = resp.headers()['content-type'] || ''
    assert.ok(ct.includes('image'), `content-type doit être image (reçu: ${ct})`)
  })

  test('le placeholder "O" carré n\'est plus présent', async () => {
    const placeholderSquare = page.locator('.bg-brand-600.rounded-2xl')
    assert.equal(await placeholderSquare.count(), 0, 'le placeholder vert ne doit plus exister')
  })

  test('le formulaire de connexion reste fonctionnel', async () => {
    await assert.doesNotReject(page.waitForSelector('input[type="email"]'))
    await assert.doesNotReject(page.waitForSelector('input[type="password"]'))
    await assert.doesNotReject(page.waitForSelector('button:has-text("Se connecter")'))
  })
})
