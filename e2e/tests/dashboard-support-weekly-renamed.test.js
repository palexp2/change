// Vérifie que la section support hebdomadaire du dashboard s'appelle
// désormais « Billets par semaine » (et plus « Amélioration du support »)
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Dashboard — section « Billets par semaine »', () => {
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
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })
  })

  after(async () => { await browser?.close() })

  test('le titre « Billets par semaine » est affiché', async () => {
    const titre = page.locator('h2:has-text("Billets par semaine")')
    await titre.first().waitFor({ state: 'visible', timeout: 15000 })
    assert.equal(await titre.count(), 1, 'la section « Billets par semaine » doit apparaître une seule fois')
  })

  test('l\'ancien libellé « Amélioration du support » a disparu', async () => {
    const ancien = page.locator(':text("Amélioration du support")')
    assert.equal(await ancien.count(), 0, 'l\'ancien titre ne doit plus être présent')
  })

  test('la carte conserve son contenu (lien Voir tickets + sous-titre)', async () => {
    const carte = page.locator('.card').filter({ has: page.locator('h2:has-text("Billets par semaine")') })
    await carte.first().waitFor({ state: 'visible', timeout: 10000 })
    const texte = await carte.first().innerText()
    assert.ok(/16 dernières semaines/.test(texte), 'le sous-titre « 16 dernières semaines » doit rester')
    assert.ok(/Voir tickets/.test(texte), 'le lien « Voir tickets » doit rester')
  })
})
