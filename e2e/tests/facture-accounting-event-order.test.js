const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// TDGMEWE0-0002 — paid_at est 6 s avant created_at (même heure).
// Avant le fix, l'encaissement Stripe apparaissait au-dessus de la création.
// Après le fix, la création doit toujours précéder l'encaissement quand les
// deux événements sont dans la même fenêtre proche (< 1h).
const FACTURE_ID = '9e045250-9767-4675-a54c-ffb0b7094d10'

describe('FactureDetail — Ordre des événements (créée avant encaissée, même heure)', () => {
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

  test('« Facture créée » est affichée au-dessus de « Encaissée » même si paid_at < created_at', async () => {
    await page.goto(`${URL}/factures/${FACTURE_ID}`, { waitUntil: 'domcontentloaded' })
    const section = page.getByTestId('facture-accounting-section')
    await section.waitFor({ state: 'visible', timeout: 10000 })

    const createdRow = section.getByTestId('event-created')
    const paidRow = section.getByTestId('event-paid-stripe')
    await createdRow.waitFor({ state: 'visible', timeout: 5000 })
    await paidRow.waitFor({ state: 'visible', timeout: 5000 })

    const createdY = (await createdRow.boundingBox()).y
    const paidY = (await paidRow.boundingBox()).y
    assert.ok(
      createdY < paidY,
      `« Facture créée » (y=${createdY}) doit être au-dessus de « Encaissée » (y=${paidY})`
    )
  })
})
