// Vérifie que la page /login ne contient plus la section
// "Première utilisation? Configurer l'application".
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'

describe('Login — pas de section configuration', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    // Attendre que le formulaire soit rendu
    await page.waitForSelector('input[type="email"]', { timeout: 10000 })
  })

  after(async () => { await browser?.close() })

  test('le texte "Première utilisation" est absent', async () => {
    const html = await page.content()
    assert.ok(!html.includes('Première utilisation'), 'texte "Première utilisation" ne devrait plus être présent')
    assert.ok(!html.includes('Configurer l\'application'), 'texte "Configurer l\'application" ne devrait plus être présent')
  })

  test('aucun lien vers /setup', async () => {
    const setupLinks = await page.locator('a[href*="/setup"]').count()
    assert.equal(setupLinks, 0, 'aucun lien vers /setup ne devrait être présent')
  })

  test('le formulaire de connexion reste fonctionnel', async () => {
    await assert.doesNotReject(page.waitForSelector('input[type="email"]'))
    await assert.doesNotReject(page.waitForSelector('input[type="password"]'))
    await assert.doesNotReject(page.waitForSelector('button:has-text("Se connecter")'))
  })
})
