// Vérifie que la section "Produits" du modal affiche une ligne Rabais
// (avec le nom du coupon Stripe et le montant négatif) pour les abonnements
// avec un coupon récurrent. Cas concret : Feast Land Farm — coupon -5 USD.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Abonnements — section Produits avec rabais', () => {
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

  test('Feast Land Farm — Rabais −5,00 USD visible et Total avant taxes = 20,00', async () => {
    await page.goto(`${URL}/abonnements`, { waitUntil: 'networkidle' })
    await page.waitForSelector('text=/\\d+\\s+lignes?/', { timeout: 10000 })

    // Recherche "Feast Land"
    const search = page.locator('input[type="search"], input[placeholder*="echerch" i]').first()
    await search.waitFor({ state: 'visible', timeout: 5000 })
    await search.fill('Feast Land')
    await page.waitForTimeout(400)

    // Ouvrir la modale
    const link = page.locator('a[href*="/companies/"]').first()
    await link.waitFor({ state: 'visible', timeout: 5000 })
    const box = await link.boundingBox()
    assert.ok(box)
    await page.mouse.click(box.x + box.width + 200, box.y + box.height / 2)

    await page.waitForSelector('text=/Détails de l.abonnement/', { timeout: 5000 })
    await page.waitForSelector('h4:has-text("Produits")', { timeout: 15000 })

    const productsHeading = page.locator('h4:has-text("Produits")')
    const productsTable = productsHeading.locator('xpath=following-sibling::div[1]//table')
    await productsTable.waitFor({ state: 'visible' })

    // La ligne Rabais doit être dans le tbody avec un montant négatif (−5.00)
    const tbodyText = (await productsTable.locator('tbody').textContent()) || ''
    assert.match(tbodyText, /Rabais/i, `attendu une ligne "Rabais" dans tbody, vu :\n${tbodyText}`)
    assert.match(tbodyText, /−\s*5\.00/, `attendu "−5.00" dans tbody, vu :\n${tbodyText}`)

    // Le footer "Total avant taxes" doit refléter le rabais : 25 − 5 = 20
    const footerText = (await productsTable.locator('tfoot').textContent()) || ''
    assert.match(footerText, /Total avant taxes/i)
    assert.match(footerText, /20\.00/, `attendu "20.00" dans le footer après rabais, vu :\n${footerText}`)
  })
})
