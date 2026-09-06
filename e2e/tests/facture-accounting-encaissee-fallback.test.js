// Régression : la section Historique des événements doit générer un événement
// d'encaissement à partir d'une row `payments` (Interac, chèque, virement…) même
// quand `factures.paid_at` est NULL. Avant la refonte timeline c'était la tuile
// « Encaissée » qui pouvait être muette dans ce cas.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const FACTURE_ID = '9e045250-9767-4675-a54c-ffb0b7094d10' // TDGMEWE0-0002 (utilisée par d'autres tests)

describe('FactureAccountingSection — encaissement hors-Stripe (paid_at=NULL + row payments)', () => {
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

  test('Génère un événement d\'encaissement Interac avec date, montant et lien QB Deposit', async () => {
    await page.route(`**/api/projets/factures/${FACTURE_ID}`, async (route, req) => {
      if (req.method() !== 'GET') return route.continue()
      const response = await route.fetch()
      const body = await response.json()
      body.paid_at = null
      body.paid_amount = null
      body.paid_charge_id = null
      body.paid_payment_intent = null
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      })
    })
    await page.route(`**/api/payments/facture/${FACTURE_ID}`, route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{
          id: 'mock-encaissee-1',
          facture_id: FACTURE_ID,
          direction: 'in',
          method: 'interac',
          received_at: '2026-05-08T00:00:00.000Z',
          amount: 4139.10,
          currency: 'CAD',
          amount_cad: 4139.10,
          exchange_rate: 1,
          qb_deposit_id: '99999',
          qb_deposit_url: 'https://qbo.intuit.com/app/deposit?txnId=99999',
          qb_payment_id: null,
          qb_payment_url: null,
          qb_journal_entry_id: null,
          qb_journal_entry_url: null,
          stripe_charge_id: null,
          stripe_refund_id: null,
          synthetic: false,
        }]),
      })
    })

    await page.goto(`${URL}/factures/${FACTURE_ID}`, { waitUntil: 'domcontentloaded' })
    const section = page.getByTestId('facture-accounting-section')
    await section.waitFor({ state: 'visible', timeout: 10000 })

    // Événement « Encaissement Interac » présent
    const row = section.locator('[data-testid="event-pay-mock-encaissee-1"]')
    await row.waitFor({ state: 'visible', timeout: 5000 })
    await assert.doesNotReject(row.getByText(/Encaissement Interac/i).waitFor({ state: 'visible', timeout: 5000 }))
    // Montant formaté fr-CA
    await assert.doesNotReject(row.getByText(/4\s139,10/).waitFor({ state: 'visible', timeout: 5000 }))
    // Lien QB Deposit
    await assert.doesNotReject(row.getByText(/DEP #99999/).waitFor({ state: 'visible', timeout: 5000 }))
  })

  test('Affiche uniquement « Facture créée » quand paid_at=NULL et zéro row payments', async () => {
    await page.route(`**/api/projets/factures/${FACTURE_ID}`, async (route, req) => {
      if (req.method() !== 'GET') return route.continue()
      const response = await route.fetch()
      const body = await response.json()
      body.paid_at = null
      body.paid_amount = null
      body.paid_charge_id = null
      body.paid_payment_intent = null
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      })
    })
    await page.route(`**/api/payments/facture/${FACTURE_ID}`, route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      })
    })

    await page.goto(`${URL}/factures/${FACTURE_ID}`, { waitUntil: 'domcontentloaded' })
    const section = page.getByTestId('facture-accounting-section')
    await section.waitFor({ state: 'visible', timeout: 10000 })
    // L'événement « Facture créée » est toujours présent (créé à la création).
    await section.getByTestId('event-created').waitFor({ state: 'visible', timeout: 5000 })
    // Pas d'événement d'encaissement, ni de constatation (paid_at = NULL).
    assert.equal(await section.locator('[data-testid="event-paid-stripe"]').count(), 0)
  })
})
