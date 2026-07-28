const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie que les montants (sous-total, TPS, TVQ, autres taxes, total) d'un
// reçu peuvent être édités depuis la fiche détail avec autosave. Le test
// sauvegarde les valeurs originales et les restaure dans after().

describe('Extraction de données : édition manuelle des taxes et montants', () => {
  let browser, ctx, page
  let token, receiptId, original

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
    // Évite les reçus en mode « piloté par les codes » (tax_code_id défini) où TPS/TVQ
    // sont en lecture seule : ce test édite les taxes manuellement.
    const candidate = body.data.find(r => r.status === 'done' && !r.tax_code_id) || body.data.find(r => r.status === 'done')
    assert.ok(candidate, 'Préalable : au moins un reçu status=done est requis')
    receiptId = candidate.id
    original = {
      subtotal: candidate.subtotal,
      tps: candidate.tps,
      tvq: candidate.tvq,
      other_taxes: candidate.other_taxes,
      total: candidate.total,
    }

    await page.goto(URL + '/sale-receipts/' + receiptId, { waitUntil: 'networkidle' })
    await page.getByTestId('receipt-amount-tps').waitFor({ state: 'visible', timeout: 10000 })
  })

  after(async () => {
    if (receiptId && token) {
      await page.request.patch(URL + '/api/sale-receipts/' + receiptId, {
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        data: original,
      })
    }
    await browser?.close()
  })

  test('modifier TPS et TVQ persiste en DB (autosave on blur)', async () => {
    const tpsInput = page.getByTestId('receipt-amount-tps')
    const tvqInput = page.getByTestId('receipt-amount-tvq')

    await tpsInput.fill('5.25')
    await tpsInput.blur()
    await page.waitForTimeout(500)

    await tvqInput.fill('10.47')
    await tvqInput.blur()
    await page.waitForTimeout(500)

    const resp = await page.request.get(URL + '/api/sale-receipts/' + receiptId, {
      headers: { Authorization: 'Bearer ' + token },
    })
    const body = await resp.json()
    assert.equal(body.tps, 5.25, 'TPS doit être 5.25 en DB')
    assert.equal(body.tvq, 10.47, 'TVQ doit être 10.47 en DB')
  })

  test('vider un champ remet la valeur à null', async () => {
    const otherInput = page.getByTestId('receipt-amount-other_taxes')
    await otherInput.fill('')
    await otherInput.blur()
    await page.waitForTimeout(500)

    const resp = await page.request.get(URL + '/api/sale-receipts/' + receiptId, {
      headers: { Authorization: 'Bearer ' + token },
    })
    const body = await resp.json()
    assert.equal(body.other_taxes, null, 'other_taxes doit être null après vidage')
  })
})
