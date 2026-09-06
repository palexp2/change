const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Parse un montant fr-CA ("12,34 $", espaces insécables) en nombre.
function parseCad(txt) {
  const cleaned = (txt || '').replace(/[^\d,.-]/g, '').replace(',', '.')
  return Math.round(parseFloat(cleaned) * 100) / 100
}

describe('Fiche reçu — ligne « Total des taxes »', () => {
  let browser, ctx, page
  let receipt = null

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    // Reçu déjà extrait avec au moins une taxe — pour vérifier la somme.
    receipt = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/sale-receipts?limit=all', { headers: { Authorization: `Bearer ${token}` } })
      const list = (await r.json()).data || []
      return list.find(x => x.status === 'done' && ((x.tps || 0) + (x.tvq || 0) + (x.other_taxes || 0)) > 0) || null
    })
    assert.ok(receipt, 'aucun reçu done avec taxes disponible pour le test')
  })

  after(async () => { await browser?.close() })

  test('affiche TPS + TVQ + autres taxes', async () => {
    await page.goto(`${URL}/sale-receipts/${receipt.id}`, { waitUntil: 'networkidle' })
    const cell = page.locator('[data-testid="receipt-total-taxes"]')
    await cell.waitFor({ state: 'visible', timeout: 10000 })

    const shown = parseCad(await cell.inputValue())
    const expected = Math.round(((receipt.tps || 0) + (receipt.tvq || 0) + (receipt.other_taxes || 0)) * 100) / 100
    assert.ok(Math.abs(shown - expected) < 0.01, `total taxes affiché ${shown} ≠ attendu ${expected}`)
  })
})
