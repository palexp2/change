// Vérifie que la page détail d'une facture (FactureDetail) affiche la ligne
// de rabais Stripe (coupon) sous les line items.
// Cas concret : Feast Land Farm — facture 23467A23-0014, coupon -5 USD.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const FACTURE_ID = '61f35cf8-2386-4e22-9bf6-9c9f8f5a766c' // Feast Land Farm 23467A23-0014

describe('FactureDetail — ligne de rabais', () => {
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

  test('Feast Land Farm 23467A23-0014 — ligne "Rabais" avec −5,00 USD visible', async () => {
    await page.goto(`${URL}/factures/${FACTURE_ID}`, { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="facture-items"]', { timeout: 10000 })

    const itemsSection = page.locator('[data-testid="facture-items"]')
    const text = (await itemsSection.textContent()) || ''

    assert.match(text, /Rabais/, `attendu "Rabais" dans la section, vu :\n${text}`)
    // Le label doit inclure le nom du coupon (Neversink22), pas juste "Rabais"
    assert.match(text, /Rabais\s*:\s*Neversink22/i,
      `attendu "Rabais : Neversink22…" (nom du coupon), vu :\n${text}`)
    // Le montant en USD est formaté différemment selon Intl mais doit contenir 5,00 ou 5.00
    assert.match(text, /−\s*[^0-9-]*5[.,]00/, `attendu "−5,00" dans la section Rabais, vu :\n${text}`)
  })
})
