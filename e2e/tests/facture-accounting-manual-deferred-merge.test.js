const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Facture avec un encaissement manuel Interac (paiement DEP #17365) et un
// revenu perçu d'avance posté sur le même dépôt QB (deferred_revenue_qb_ref =
// deposit:17365). Les deux événements doivent fusionner en une seule ligne
// « Encaissement Interac + revenu perçu d'avance », datée à la date de
// l'encaissement.
const FACTURE_ID = 'c04e3428-f7fc-4ebe-985e-0b8be67bc0f1'

describe('FactureDetail — Historique : fusion encaissement manuel + revenu perçu d\'avance', () => {
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

  test('L\'encaissement manuel absorbe le revenu perçu d\'avance — une seule ligne fusionnée', async () => {
    await page.goto(`${URL}/factures/${FACTURE_ID}`, { waitUntil: 'domcontentloaded' })
    const section = page.getByTestId('facture-accounting-section')
    await section.waitFor({ state: 'visible', timeout: 10000 })
    // Le label fusionné apparaît.
    await section.getByText(/Encaissement Interac \+ revenu perçu d'avance/).waitFor({ state: 'visible', timeout: 5000 })
    // Le standalone « Revenu perçu d'avance posté » NE doit PAS exister.
    const standalone = section.getByTestId('event-deferred')
    assert.equal(await standalone.count(), 0, 'pas d\'événement deferred séparé attendu')
    // Une seule ligne d'encaissement (pas de duplication).
    const payRows = section.locator('[data-testid^="event-pay-"]')
    assert.equal(await payRows.count(), 1, 'une seule ligne d\'encaissement attendue')
    // Le lien vers le dépôt QB (DEP #17365) est sur la ligne fusionnée.
    const depLink = payRows.first().locator('text=/DEP #17365/')
    await depLink.waitFor({ state: 'visible', timeout: 5000 })
    // Le détail comptable Dr 12000 · Cr 23900 est affiché sur la ligne
    // (12000 = AR CAD ; le paiement est en CAD).
    const details = payRows.first().locator('text=/Dr 12000 · Cr 23900/')
    await details.waitFor({ state: 'visible', timeout: 5000 })
  })
})
