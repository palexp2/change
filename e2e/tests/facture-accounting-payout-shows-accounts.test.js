const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// 577EF696-0004 — facture order payée, revenue_recognized_at=null +
// deferred_revenue_at=null (cas « constatée direct depo »). Le payout
// po_1TX9vFEO122sMsbJXlpzXyXc (DEP #17328) crédite donc 40000.
const FACTURE_ID = '515de2c3-aa8d-4641-8096-be6d246e7f30'

describe('FactureDetail — Historique : ligne « Payout Stripe vers banque » affiche Dr/Cr au lieu du total + frais', () => {
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

  test('La ligne payout affiche les comptes Dr Banque · Cr 40000 et plus ni le total ni les frais', async () => {
    await page.goto(`${URL}/factures/${FACTURE_ID}`, { waitUntil: 'domcontentloaded' })
    const section = page.getByTestId('facture-accounting-section')
    await section.waitFor({ state: 'visible', timeout: 10000 })

    const payoutRow = section.locator('[data-testid^="event-payout-"]').first()
    await payoutRow.waitFor({ state: 'visible', timeout: 10000 })

    const text = (await payoutRow.innerText()).replace(/\s+/g, ' ').trim()

    // Affiche le label attendu
    assert.match(text, /Payout Stripe vers banque/, 'label payout attendu')

    // Affiche Dr Banque · Cr 40000 (cette facture = constatée direct au deposit)
    assert.match(text, /Dr Banque · Cr 40000/, `attendu "Dr Banque · Cr 40000", reçu: ${text}`)

    // Ne doit plus afficher le total du payout (po_1TX9vF = 6 306,40 $) ni
    // le mot « frais » qui précédait le total des frais Stripe.
    assert.ok(!/6\s?306[,.]40/.test(text),
      `le total du payout ne doit plus apparaître, reçu: ${text}`)
    assert.ok(!/frais\s/i.test(text),
      `le mot "frais" ne doit plus apparaître, reçu: ${text}`)

    // Le lien vers le Deposit QB doit rester présent.
    const depLink = payoutRow.locator('text=/DEP #17328/')
    await depLink.waitFor({ state: 'visible', timeout: 5000 })
  })
})
