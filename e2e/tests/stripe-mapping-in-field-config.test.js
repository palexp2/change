const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// La correspondance Stripe (ex-modale « Sync Stripe » de /factures) vit dans la
// page des champs, à côté de la colonne Airtable. Lecture seule : rien n'est
// enregistré ni ré-importé.
describe('Correspondance Stripe dans /champs', () => {
  let browser, page

  before(async () => {
    browser = await chromium.launch()
    page = await (await browser.newContext({ viewport: { width: 1500, height: 900 } })).newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => { await browser?.close() })

  test('/factures n\'a plus de bouton « Sync Stripe »', async () => {
    await page.goto(URL + '/factures', { waitUntil: 'domcontentloaded' })
    await page.locator('text=/\\d+ lignes?/').first().waitFor({ timeout: 15000 })
    assert.strictEqual(await page.locator('button:has-text("Sync Stripe")').count(), 0)
  })

  test('/champs/factures — source Stripe + colonnes Airtable et Stripe', async () => {
    await page.goto(URL + '/champs/factures', { waitUntil: 'domcontentloaded' })
    await page.locator('[data-testid="fieldcfg-stripe-source"]').waitFor({ timeout: 15000 })
    const header = await page.locator('[data-testid="fieldcfg-header"]').innerText()
    assert.match(header, /Champ Airtable/i)
    assert.match(header, /Champ Stripe/i)
    await page.locator('[data-testid="stripemap-total_amount"]').waitFor({ timeout: 15000 })
    await page.locator('[data-testid="stripemap-fixed-status"]').waitFor({ timeout: 15000 })
  })

  test('/champs/abonnements — colonne Stripe', async () => {
    await page.goto(URL + '/champs/abonnements', { waitUntil: 'domcontentloaded' })
    await page.locator('[data-testid="fieldcfg-stripe-source"]').waitFor({ timeout: 15000 })
    await page.locator('[data-testid="stripemap-start_date"]').waitFor({ timeout: 15000 })
  })
})
