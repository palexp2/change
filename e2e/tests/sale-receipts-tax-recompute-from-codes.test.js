const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Recalcul AUTOMATIQUE des TPS/TVQ à partir des codes de taxe (scénario resto type
// Bloom Sushi : bouffe taxable + pourboire Hors champ). Choisir un code par défaut du
// document doit recalculer les taxes ; changer un code de ligne doit les remettre à jour.
// Sauvegarde + restaure items / montants / tax_code_id du reçu (DB prod = DB test).

describe('Extraction de données : recalcul des taxes depuis les codes', () => {
  let browser, ctx, page
  let token, receiptId, qc, horsChamp
  let original

  const get = async () => (await (await page.request.get(URL + '/api/sale-receipts/' + receiptId, { headers: { Authorization: 'Bearer ' + token } })).json())

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

    const tc = await page.request.get(URL + '/api/connectors/quickbooks/tax-codes', { headers: { Authorization: 'Bearer ' + token } })
    const codes = tc.ok() ? await tc.json() : []
    qc = codes.find(c => c.Name === 'TPS/TVQ QC - 9,975')
    horsChamp = codes.find(c => c.Name === 'Hors champ')

    const list = await (await page.request.get(URL + '/api/sale-receipts?limit=all', { headers: { Authorization: 'Bearer ' + token } })).json()
    const cand = list.data.find(r => r.status === 'done' && !r.quickbooks_id)
    assert.ok(cand, 'un reçu done non publié est requis')
    receiptId = cand.id
    original = {
      items: cand.items || [], subtotal: cand.subtotal ?? null, tps: cand.tps ?? null,
      tvq: cand.tvq ?? null, other_taxes: cand.other_taxes ?? null, total: cand.total ?? null,
      tax_code_id: cand.tax_code_id ?? null,
    }
  })

  after(async () => {
    if (receiptId && token) {
      await page.request.patch(URL + '/api/sale-receipts/' + receiptId, {
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        data: { ...original },
      })
    }
    await browser?.close()
  })

  test('choisir un code par défaut recalcule les taxes (pourboire exclu)', async () => {
    if (!qc || !horsChamp) { console.log('QB non connecté ou codes absents — test ignoré.'); return }
    // Setup : bouffe 79 (sans code → suivra le défaut), pourboire 14,22 (Hors champ).
    // Taxes initiales volontairement fausses (calculées sur le total avec pourboire).
    await page.request.patch(URL + '/api/sale-receipts/' + receiptId, {
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      data: {
        items: [
          { description: 'Bouffe E2E', quantity: null, unit_price: null, total: 79, tax_code_id: null },
          { description: 'Pourboire E2E', quantity: null, unit_price: null, total: 14.22, tax_code_id: horsChamp.Id },
        ],
        subtotal: 93.22, tps: 4.66, tvq: 9.30, other_taxes: 0, total: 107.18, tax_code_id: null,
      },
    })

    await page.goto(URL + '/sale-receipts/' + receiptId, { waitUntil: 'networkidle' })
    const sel = page.getByTestId('receipt-doc-taxcode')
    await sel.waitFor({ state: 'visible', timeout: 10000 })
    await sel.click()
    const menu = page.getByTestId('receipt-doc-taxcode-menu')
    await menu.waitFor({ state: 'visible', timeout: 5000 })
    await menu.locator('input').fill('TPS/TVQ QC')
    await menu.getByText('TPS/TVQ QC - 9,975', { exact: false }).first().click()
    await page.waitForTimeout(1000)

    const r = await get()
    assert.equal(r.tax_code_id, qc.Id, 'le code par défaut doit être enregistré')
    // Bouffe 79 taxable, pourboire Hors champ → taxes sur 79 seulement.
    assert.equal(r.tps, 3.95, 'TPS recalculée sur 79 (5%)')
    assert.equal(r.tvq, 7.88, 'TVQ recalculée sur 79 (9,975%)')
    assert.equal(r.total, 105.05, 'total = 93,22 + 3,95 + 7,88')
  })

  test('changer le code d\'une ligne met les taxes à jour', async () => {
    if (!qc || !horsChamp) return
    // Pourboire Hors champ → TPS/TVQ QC : il devient taxable, les taxes remontent.
    const sel = page.getByTestId('receipt-item-taxcode-1')
    await sel.scrollIntoViewIfNeeded()
    await sel.click()
    const menu = page.getByTestId('receipt-item-taxcode-1-menu')
    await menu.waitFor({ state: 'visible', timeout: 5000 })
    await menu.locator('input').fill('TPS/TVQ QC')
    await menu.getByText('TPS/TVQ QC - 9,975', { exact: false }).first().click()
    await page.waitForTimeout(1000)

    const r = await get()
    // Tout taxable (93,22) → TPS 4,66 / TVQ 9,30.
    assert.equal(r.tps, 4.66, 'TPS sur 93,22')
    assert.equal(r.tvq, 9.30, 'TVQ sur 93,22')
    assert.equal(r.total, 107.18)
  })
})
