const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Régression : dans la fiche entreprise, l'onglet Factures doit afficher pour
// les remboursements (sync_source='Remboursements Stripe') le montant HT et non
// le montant TTC. Le bug initial : amount_before_tax_cad du refund stockait le
// brut TTC remboursé (Stripe ne renvoie pas le HT sur un balance_transaction).
// Le fix dérive le HT via le ratio HT/TTC de la facture d'origine.
describe('CompanyDetail — onglet Factures : remboursements affichent HT pré-tax', () => {
  let browser, ctx, page, token, companyId, refund, original

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
    token = await page.evaluate(() => localStorage.getItem('erp_token'))

    // Cherche un refund avec une facture d'origine du même montant TTC, dans
    // la même company, avec une vraie taxe (HT < TTC sur l'origine).
    const found = await page.evaluate(async (tok) => {
      const r = await fetch('/erp/api/projets/factures?limit=all', { headers: { Authorization: `Bearer ${tok}` } })
      const j = await r.json()
      const list = j.data || []
      const refunds = list.filter(x => x.sync_source === 'Remboursements Stripe' && x.company_id)
      for (const ref of refunds) {
        const orig = list.find(x =>
          x.company_id === ref.company_id &&
          x.sync_source !== 'Remboursements Stripe' &&
          Number(x.total_amount) > Number(x.amount_before_tax_cad) &&
          Math.abs(Number(x.total_amount) - Number(ref.total_amount)) < 0.01
        )
        if (orig) return { refund: ref, original: orig }
      }
      return null
    }, token)
    assert.ok(found, 'devrait trouver un refund avec facture d\'origine taxable')
    refund = found.refund
    original = found.original
    companyId = refund.company_id
  })

  after(async () => { await browser?.close() })

  test('le HT du remboursement vaut le HT pré-tax (ratio appliqué), pas le TTC', async () => {
    // Sanity check API : le HT du refund renvoyé par l'API doit être < TTC
    // (sinon le ratio n'a pas été appliqué).
    const ratio = original.amount_before_tax_cad / original.total_amount
    const expectedHt = refund.total_amount * ratio
    assert.ok(
      Math.abs(refund.amount_before_tax_cad - expectedHt) < 0.05,
      `API: HT refund attendu ≈${expectedHt.toFixed(2)}, reçu ${refund.amount_before_tax_cad}`
    )
    assert.ok(
      refund.amount_before_tax_cad < refund.total_amount - 0.01,
      `API: HT refund (${refund.amount_before_tax_cad}) doit être < TTC (${refund.total_amount}) — sinon affiché TTC à tort`
    )

    // UI : la cellule Total HT du refund doit montrer le HT, pas le TTC
    await page.goto(`${URL}/companies/${companyId}`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle')
    await page.click('button:has-text("factures")')
    await page.locator('th:has-text("N° document")').waitFor({ state: 'visible', timeout: 5000 })

    const refundRow = page.locator('table tbody tr', { hasText: refund.document_number })
    await refundRow.first().waitFor({ state: 'visible', timeout: 5000 })
    const cells = await refundRow.first().locator('td').allTextContents()
    // Ordre : N° document, Statut, Date, Total HT, Devise
    const totalHtCell = cells[3]
    const numeric = parseFloat(totalHtCell.replace(/[^\d.,-]/g, '').replace(/\s/g, '').replace(',', '.'))
    assert.ok(
      Math.abs(numeric - expectedHt) < 0.05,
      `UI: cellule Total HT du refund "${totalHtCell}" → ${numeric}, attendu ≈${expectedHt.toFixed(2)}`
    )
  })
})
