const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Régression : sur la fiche détail d'un remboursement (status='Remboursement'),
// les trois lignes du résumé "Avant taxes / <Taxe> / Total" doivent être
// cohérentes — Total ≈ Avant taxes + Taxes. Le bug initial : le backfill stockait
// le brut TTC dans `amount_before_tax_cad`/`montant_avant_taxes` ET dans
// `total_amount`, donc l'UI montrait avant=TTC, taxe=HST(TTC), total=TTC.
describe('FactureDetail — remboursement : Avant + Taxes ≈ Total', () => {
  let browser, ctx, page, refundId

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
    const token = await page.evaluate(() => localStorage.getItem('erp_token'))

    // Cherche un refund avec une facture d'origine taxée dans la même devise
    // (HT_native < TTC_native sur l'origine, ratio < 1).
    const found = await page.evaluate(async (tok) => {
      const r = await fetch('/erp/api/projets/factures?limit=all', { headers: { Authorization: `Bearer ${tok}` } })
      const j = await r.json()
      const list = j.data || []
      const refunds = list.filter(x => x.sync_source === 'Remboursements Stripe' && x.company_id)
      for (const ref of refunds) {
        const orig = list.find(x =>
          x.company_id === ref.company_id &&
          x.sync_source !== 'Remboursements Stripe' &&
          x.currency === ref.currency &&
          parseFloat(x.montant_avant_taxes) > 0 &&
          Number(x.total_amount) > parseFloat(x.montant_avant_taxes) + 0.01 &&
          Math.abs(Number(x.total_amount) - Number(ref.total_amount)) < 0.01
        )
        if (orig) return ref.id
      }
      return null
    }, token)
    assert.ok(found, 'devrait trouver un refund avec facture d\'origine taxée et même devise')
    refundId = found
  })

  after(async () => { await browser?.close() })

  test('Avant taxes < Total et Avant + Taxes ≈ Total', async () => {
    await page.goto(`${URL}/factures/${refundId}`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="facture-line-subtotal"]', { timeout: 10000 })

    const parseMoney = (s) => parseFloat(
      String(s).replace(/[^0-9.,-]/g, '').replace(/\s/g, '').replace(',', '.')
    )

    const subtotalText = (await page.locator('[data-testid="facture-line-subtotal"] td').last().innerText()).trim()
    const totalText = (await page.locator('[data-testid="facture-line-total"] td').last().innerText()).trim()
    const taxRows = page.locator('[data-testid="facture-line-tax"]')
    const taxCount = await taxRows.count()
    let taxesSum = 0
    for (let i = 0; i < taxCount; i++) {
      const cellText = (await taxRows.nth(i).locator('td').last().innerText()).trim()
      taxesSum += parseMoney(cellText)
    }

    const subtotal = parseMoney(subtotalText)
    const total = parseMoney(totalText)

    assert.ok(taxCount > 0, `attendu au moins une ligne de taxe (rendu: subtotal=${subtotalText}, total=${totalText})`)
    assert.ok(
      subtotal < total - 0.01,
      `Avant taxes (${subtotal}) doit être < Total (${total}) — sinon HT == TTC, c'est le bug`
    )
    assert.ok(
      Math.abs((subtotal + taxesSum) - total) < 0.05,
      `Avant taxes (${subtotal}) + Taxes (${taxesSum}) = ${subtotal + taxesSum} doit ≈ Total (${total})`
    )
  })
})
