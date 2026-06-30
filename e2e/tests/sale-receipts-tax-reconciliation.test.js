const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie l'indicateur de réconciliation des taxes (section Montants) : il compare la
// taxe IMPLIQUÉE par les codes de taxe par ligne au total des taxes du document.
// - Codes cohérents → « correspond ».
// - Une ligne passée à « Aucune taxe » → « écart ».
// Le test sauvegarde items[] + montants du reçu et les restaure dans after().

describe('Extraction de données : réconciliation des taxes par ligne', () => {
  let browser, ctx, page
  let token, receiptId, originalItems, originalAmounts, qcCode

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

    // Code QB « TPS/TVQ QC - 9,975 » (14,975 %) — requis pour le scénario cohérent.
    const tc = await page.request.get(URL + '/api/connectors/quickbooks/tax-codes', { headers: { Authorization: 'Bearer ' + token } })
    const codes = tc.ok() ? await tc.json() : []
    qcCode = codes.find(c => c.Name === 'TPS/TVQ QC - 9,975')

    const resp = await page.request.get(URL + '/api/sale-receipts?limit=all', { headers: { Authorization: 'Bearer ' + token } })
    const body = await resp.json()
    const candidate = body.data.find(r => r.status === 'done' && !r.quickbooks_id) || body.data.find(r => r.status === 'done')
    assert.ok(candidate, 'Préalable : un reçu status=done est requis')
    receiptId = candidate.id
    originalItems = candidate.items || []
    originalAmounts = {
      subtotal: candidate.subtotal ?? null, tps: candidate.tps ?? null,
      tvq: candidate.tvq ?? null, other_taxes: candidate.other_taxes ?? null, total: candidate.total ?? null,
    }
  })

  after(async () => {
    if (receiptId && token) {
      await page.request.patch(URL + '/api/sale-receipts/' + receiptId, {
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        data: { items: originalItems, ...originalAmounts },
      })
    }
    await browser?.close()
  })

  test('codes cohérents → indicateur « correspond »', async () => {
    if (!qcCode) { console.log('QB non connecté ou code QC absent — test ignoré.'); return }
    // 1 ligne taxable 100 $ au code TPS/TVQ QC ; taxes document = 14,975 (= 14,98 arrondi).
    await page.request.patch(URL + '/api/sale-receipts/' + receiptId, {
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      data: {
        items: [{ description: 'E2E ligne taxable', quantity: null, unit_price: null, total: 100, tax_code_id: qcCode.Id }],
        subtotal: 100, tps: 5, tvq: 9.975, other_taxes: 0, total: 114.975,
      },
    })

    await page.goto(URL + '/sale-receipts/' + receiptId, { waitUntil: 'networkidle' })
    const row = page.getByTestId('receipt-tax-reconciliation')
    await row.waitFor({ state: 'visible', timeout: 10000 })
    await assert.doesNotReject(row.getByText('correspond').waitFor({ state: 'visible', timeout: 5000 }))
  })

  test('passer une ligne à « Aucune taxe » → indicateur « écart »', async () => {
    if (!qcCode) return
    // La ligne est encore au code QC cohérent ; on la bascule en « Aucune taxe » via l'UI.
    const select = page.getByTestId('receipt-item-taxcode-0')
    await select.scrollIntoViewIfNeeded()
    await select.click()
    const menu = page.getByTestId('receipt-item-taxcode-0-menu')
    await menu.waitFor({ state: 'visible', timeout: 5000 })
    await menu.getByText('Aucune taxe', { exact: false }).first().click()
    await page.waitForTimeout(900)

    // Persistance du sentinel en DB.
    const resp = await page.request.get(URL + '/api/sale-receipts/' + receiptId, { headers: { Authorization: 'Bearer ' + token } })
    const body = await resp.json()
    assert.equal(body.items[0].tax_code_id, '__none__', 'le sentinel « aucune taxe » doit être persisté')

    // L'indicateur doit maintenant signaler un écart (taxe impliquée 0 vs 14,98 saisi).
    const row = page.getByTestId('receipt-tax-reconciliation')
    await assert.doesNotReject(row.getByText('écart', { exact: false }).waitFor({ state: 'visible', timeout: 5000 }))
  })
})
