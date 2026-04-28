const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('FactureDetail — Avant taxes en devise native', () => {
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

  test("Une facture USD affiche 'Avant taxes' en USD (pas en CAD converti)", async () => {
    // Pick a USD facture that has divergent amount_before_tax_cad vs montant_avant_taxes
    const target = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/projets/factures?limit=all', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const j = await r.json()
      const list = j.data || []
      // Find one we can safely check through the single-record route
      return list.find(f => f.currency === 'USD' && f.total_amount > 0)
    })
    assert.ok(target, 'une facture USD est requise')

    // Hit the detail endpoint to get both columns
    const detail = await page.evaluate(async (id) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch(`/erp/api/projets/factures/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      return r.json()
    }, target.id)

    assert.ok(detail.montant_avant_taxes != null, 'la facture test doit avoir montant_avant_taxes')
    const native = parseFloat(detail.montant_avant_taxes)
    const cad = Number(detail.amount_before_tax_cad)

    await page.goto(URL + '/factures/' + target.id, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=Avant taxes', { timeout: 10000 })

    // Extract the Avant taxes cell value
    const avantTaxesCell = page.locator('p', { hasText: /^Avant taxes$/ }).first().locator('xpath=following-sibling::p[1]')
    const rendered = (await avantTaxesCell.innerText()).trim()

    // Parse the rendered currency string to a number
    const parsed = parseFloat(rendered.replace(/[^0-9.,-]/g, '').replace(/\s/g, '').replace(',', '.'))

    // Should match native, not CAD (when they differ)
    if (Math.abs(cad - native) > 0.5) {
      assert.ok(
        Math.abs(parsed - native) < 0.5,
        `rendered=${rendered} (${parsed}) doit correspondre à la valeur native ${native}, pas à la conversion CAD ${cad}`,
      )
    } else {
      // Values are close; still assert it's within rounding of native
      assert.ok(Math.abs(parsed - native) < 0.5, `rendered=${rendered} (${parsed}) ≠ native ${native}`)
    }
  })
})
