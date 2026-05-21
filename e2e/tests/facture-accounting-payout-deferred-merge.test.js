const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// 577EF696-0003 — paid_at, payout (deposit #17282) et deferred_revenue_qb_ref
// = deposit:17282. Le revenu perçu d'avance est posté sur le même dépôt que
// le payout, donc les deux événements doivent être fusionnés en une seule
// ligne « Payout Stripe + revenu perçu d'avance ».
const FACTURE_ID = '128feafb-0c7d-480e-baf8-f1a37b29eb80'

describe('FactureDetail — Historique : fusion payout + revenu perçu d\'avance', () => {
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

  test('Pas de lien QB sur l\'événement « Encaissée (Stripe) »', async () => {
    await page.goto(`${URL}/factures/${FACTURE_ID}`, { waitUntil: 'domcontentloaded' })
    const section = page.getByTestId('facture-accounting-section')
    await section.waitFor({ state: 'visible', timeout: 10000 })
    const paid = section.getByTestId('event-paid-stripe')
    await paid.waitFor({ state: 'visible', timeout: 5000 })
    // L'événement Stripe doit garder son lien vers le paiement Stripe…
    const stripeLinks = await paid.locator('a[href*="dashboard.stripe.com/payments/"]').count()
    assert.ok(stripeLinks >= 1, 'le lien Stripe vers le paiement doit toujours être présent')
    // …mais aucun lien QB (DEP/JE/SR) sur cette ligne.
    const qbLink = paid.locator('[data-testid^="qb-link-paid-stripe"]')
    assert.equal(await qbLink.count(), 0, 'aucun lien QB attendu sur l\'événement Encaissée (Stripe)')
  })

  test('Le payout absorbe le revenu perçu d\'avance — une seule ligne fusionnée', async () => {
    await page.goto(`${URL}/factures/${FACTURE_ID}`, { waitUntil: 'domcontentloaded' })
    const section = page.getByTestId('facture-accounting-section')
    await section.waitFor({ state: 'visible', timeout: 10000 })
    // Le label fusionné apparaît.
    await section.getByText(/Payout Stripe \+ revenu perçu d'avance/).waitFor({ state: 'visible', timeout: 5000 })
    // Le standalone « Revenu perçu d'avance posté » NE doit PAS exister
    // (il est absorbé dans la ligne payout ci-dessus).
    const standalone = section.getByTestId('event-deferred')
    assert.equal(await standalone.count(), 0, 'pas d\'événement deferred séparé attendu')
    // Le lien vers le dépôt QB (DEP #17282) est sur la ligne payout.
    const payoutRow = section.locator('[data-testid^="event-payout-"]').first()
    await payoutRow.waitFor({ state: 'visible', timeout: 5000 })
    const depLink = payoutRow.locator('text=/DEP #17282/')
    await depLink.waitFor({ state: 'visible', timeout: 5000 })
  })
})
