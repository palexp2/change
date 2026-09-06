const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie que la devise d'un reçu peut être modifiée depuis la page Extraction
// de données, avec autosave et persistance en DB. Le test sauvegarde la valeur
// initiale et la restaure dans after() pour ne pas polluer la DB.

describe('Extraction de données : édition de la devise', () => {
  let browser, ctx, page
  let token, receiptId, originalCurrency

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    token = await page.evaluate(() => localStorage.getItem('erp_token'))
    const resp = await page.request.get(URL + '/api/sale-receipts?limit=all', {
      headers: { Authorization: 'Bearer ' + token },
    })
    const body = await resp.json()
    const candidate = body.data.find(r => r.status === 'done')
    assert.ok(candidate, 'Préalable : au moins un reçu status=done est requis')
    receiptId = candidate.id
    originalCurrency = candidate.currency || null

    await page.goto(URL + '/sale-receipts', { waitUntil: 'networkidle' })
    await page.waitForSelector('h1:has-text("Extraction de données")', { timeout: 10000 })

    const sidebarItem = page.locator(`text=${candidate.company || candidate.original_name}`).first()
    await sidebarItem.waitFor({ state: 'visible', timeout: 5000 })
    await sidebarItem.click()
    await page.getByTestId('receipt-currency').waitFor({ state: 'visible', timeout: 10000 })
  })

  after(async () => {
    // Restaure la devise originale en DB (même si le test a échoué)
    if (receiptId && token) {
      await page.request.patch(URL + '/api/sale-receipts/' + receiptId, {
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        data: { currency: originalCurrency },
      })
    }
    await browser?.close()
  })

  test('changer la devise via le sélecteur persiste en DB (autosave)', async () => {
    const target = originalCurrency === 'USD' ? 'CAD' : 'USD'
    const select = page.getByTestId('receipt-currency')
    await select.selectOption(target)

    // Attendre que l'autosave aboutisse (spinner disparaît) puis vérifier la DB
    await page.waitForTimeout(800)
    const resp = await page.request.get(URL + '/api/sale-receipts/' + receiptId, {
      headers: { Authorization: 'Bearer ' + token },
    })
    const body = await resp.json()
    assert.equal(body.currency, target, `La devise devrait être ${target} en DB`)
  })
})
