const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Les boutons d'en-tête « Mapping Stripe » / « Mapping Airtable » ont été
// renommés « Sync Stripe » / « Sync Airtable » sur toutes les pages qui en
// ont un (Factures, Orders, Products, Paies, Règles comptables serials).
// Test en lecture seule — aucun record créé, aucune configuration modifiée,
// aucune modale enregistrée.
describe('Boutons mapping renommés « Sync … »', () => {
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

  after(async () => {
    await browser?.close()
  })

  const expectLabel = async (testId, expected) => {
    const btn = page.locator(`[data-testid="${testId}"]`)
    await btn.waitFor({ state: 'visible', timeout: 15000 })
    const text = (await btn.innerText()).trim()
    assert.match(text, new RegExp(expected), `${testId} devrait afficher « ${expected} », vu « ${text} »`)
    assert.doesNotMatch(text, /Mapping/i, `${testId} ne devrait plus contenir « Mapping »`)
  }

  test('/factures : Sync Stripe + Sync Airtable', async () => {
    await page.goto(URL + '/factures', { waitUntil: 'domcontentloaded' })
    await expectLabel('factures-stripe-map-open', 'Sync Stripe')
    await expectLabel('factures-airtable-map-open', 'Sync Airtable')
  })

  test('/orders : Sync Airtable', async () => {
    await page.goto(URL + '/orders', { waitUntil: 'domcontentloaded' })
    await expectLabel('orders-airtable-map-open', 'Sync Airtable')
  })

  test('/products : Sync Airtable', async () => {
    await page.goto(URL + '/products', { waitUntil: 'domcontentloaded' })
    await expectLabel('products-airtable-map-open', 'Sync Airtable')
  })

  test('/paies : bouton scindé — segment mapping icône seule, sans « Mapping »', async () => {
    // /paies a fusionné sync + mapping en un bouton scindé : le segment mapping
    // est une icône seule (le libellé « Sync Airtable » vit sur le segment sync).
    await page.goto(URL + '/paies', { waitUntil: 'domcontentloaded' })
    const btn = page.locator('[data-testid="paies-airtable-map-open"]')
    await btn.waitFor({ state: 'visible', timeout: 15000 })
    const text = (await btn.innerText()).trim()
    assert.doesNotMatch(text, /Mapping/i, 'paies-airtable-map-open ne devrait plus contenir « Mapping »')
    await expectLabel('paies-airtable-sync', 'Sync Airtable')
  })

  test('/comptabilite/regles-serials : Sync Airtable', async () => {
    await page.goto(URL + '/comptabilite/regles-serials', { waitUntil: 'domcontentloaded' })
    // Pas de data-testid sur ce bouton — repérage par libellé
    const btn = page.locator('button:has-text("Sync Airtable")')
    await btn.first().waitFor({ state: 'visible', timeout: 15000 })
    assert.equal(
      await page.locator('button:has-text("Mapping Airtable")').count(),
      0,
      'plus aucun bouton « Mapping Airtable » sur la page'
    )
  })
})
