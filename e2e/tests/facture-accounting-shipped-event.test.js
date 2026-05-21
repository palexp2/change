const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// 577EF696-0003 — first_shipped_at = 2026-05-13 ; revenue_recognized_at =
// 2026-05-21 (≈ 8 jours d'écart). Les deux événements doivent apparaître
// distinctement dans le timeline (pas de fusion, et l'expédition ne doit
// surtout pas être avalée par la constatation).
const FACTURE_ID = '128feafb-0c7d-480e-baf8-f1a37b29eb80'

describe('FactureDetail — Historique : événement Expédiée toujours visible', () => {
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

  test('L\'événement « Expédiée » est rendu en plus de « Vente constatée » quand les dates ne sont pas proches', async () => {
    await page.goto(`${URL}/factures/${FACTURE_ID}`, { waitUntil: 'domcontentloaded' })
    const section = page.getByTestId('facture-accounting-section')
    await section.waitFor({ state: 'visible', timeout: 10000 })

    const shipped = section.getByTestId('event-shipped')
    await shipped.waitFor({ state: 'visible', timeout: 5000 })
    const recognized = section.getByTestId('event-recognized')
    await recognized.waitFor({ state: 'visible', timeout: 5000 })

    // L'expédition doit précéder la constatation (May 13 < May 21).
    const shippedY = (await shipped.boundingBox()).y
    const recognizedY = (await recognized.boundingBox()).y
    assert.ok(
      shippedY < recognizedY,
      `« Expédiée » (y=${shippedY}) doit être avant « Vente constatée » (y=${recognizedY})`
    )

    // La constatation n'est pas la version fusionnée — le label « Expédiée + vente constatée » ne doit pas apparaître ici.
    const consolidated = await section.getByText(/Expédiée \+ vente constatée/).count()
    assert.equal(consolidated, 0, 'l\'expédition et la constatation ne doivent pas être fusionnées (8 jours d\'écart)')
  })
})
