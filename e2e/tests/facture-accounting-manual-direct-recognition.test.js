const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Facture payée par virement bancaire, dont la ligne du Deposit QB crédite
// directement un compte de revenu (40000 Ventes) — l'encaissement manuel
// constate donc la vente en une seule transaction. L'historique doit afficher
// « Encaissement virement bancaire + vente constatée » (label fusionné).
const FACTURE_ID = 'cc4f1639-b90c-4c5d-ab29-6e36530ef6ab'

describe('FactureDetail — Historique : fusion encaissement manuel + vente constatée (Cr 40xxx direct)', () => {
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

  test('L\'encaissement manuel absorbe la constatation de vente — label « + vente constatée »', async () => {
    await page.goto(`${URL}/factures/${FACTURE_ID}`, { waitUntil: 'domcontentloaded' })
    const section = page.getByTestId('facture-accounting-section')
    await section.waitFor({ state: 'visible', timeout: 10000 })
    // Le label fusionné apparaît.
    await section.getByText(/Encaissement virement \+ vente constatée/).waitFor({ state: 'visible', timeout: 5000 })
    // Une seule ligne d'encaissement (pas de duplication).
    const payRows = section.locator('[data-testid^="event-pay-"]')
    assert.equal(await payRows.count(), 1, 'une seule ligne d\'encaissement attendue')
    // Aucun événement standalone « Vente constatée » (absorbé dans l'encaissement).
    const standaloneRecognition = section.getByTestId('event-recognized')
    assert.equal(await standaloneRecognition.count(), 0, 'pas d\'événement de constatation séparé attendu')
  })
})
