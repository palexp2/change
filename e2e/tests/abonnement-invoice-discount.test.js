// Vérifie qu'une facture d'abonnement avec coupon Stripe affiche bien la
// ligne de rabais (-X $) sous les line items dans la modale de détail.
// Cas concret : Feast Land Farm, abonnement avec coupon -5 $.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe("Abonnements — ligne de rabais sous chaque facture", () => {
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

  test('Feast Land Farm — la facture affiche "Rabais" et −5,00 $', async () => {
    await page.goto(`${URL}/abonnements`, { waitUntil: 'networkidle' })
    await page.waitForSelector('text=/\\d+\\s+lignes?/', { timeout: 10000 })

    // Recherche "Feast Land" via la barre de recherche du DataTable
    const search = page.locator('input[type="search"], input[placeholder*="echerch" i]').first()
    await search.waitFor({ state: 'visible', timeout: 5000 })
    await search.fill('Feast Land')
    // laisser le filtrage s'appliquer
    await page.waitForTimeout(400)

    // Cliquer sur la ligne (à droite du lien company pour ne pas naviguer)
    const link = page.locator('a[href*="/companies/"]').first()
    await link.waitFor({ state: 'visible', timeout: 5000 })
    const box = await link.boundingBox()
    assert.ok(box)
    await page.mouse.click(box.x + box.width + 200, box.y + box.height / 2)

    await page.waitForSelector('text=/Détails de l.abonnement/', { timeout: 5000 })
    await page.waitForSelector('h4:has-text("Factures")', { timeout: 15000 })

    // La section "Factures" doit contenir au moins une ligne "Rabais" avec un montant négatif
    const facturesHeading = page.locator('h4:has-text("Factures")')
    const facturesSection = facturesHeading.locator('xpath=following-sibling::div[1]')
    await facturesSection.waitFor({ state: 'visible' })

    const rabais = facturesSection.locator('text=/Rabais/')
    await rabais.first().waitFor({ state: 'visible', timeout: 5000 })

    // Vérifier qu'une ligne contient le montant négatif (5,00 $ pour Feast Land)
    const text = (await facturesSection.textContent()) || ''
    assert.match(text, /Rabais.*−\s*5\.00\s*\$/s,
      `attendu une ligne "Rabais ... −5.00 $" dans la section Factures, vu :\n${text}`)
  })
})
