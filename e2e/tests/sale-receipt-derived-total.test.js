const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Le Total de la section « Montants » doit TOUJOURS valoir sous-total + taxes
// (« le total doit correspondre aux articles et aux taxes ») : champ dérivé en
// lecture seule, recalculé et persisté à chaque édition de taxe. Un repère
// « reçu : … » apparaît si le total imprimé stocké diverge du calcul.
//
// État contrôlé posé via API, restauré dans after().

describe('Extraction de données : total dérivé (articles + taxes)', () => {
  let browser, ctx, page
  let token, receiptId, originalItems, originalAmounts

  async function getReceipt() {
    const r = await page.request.get(URL + '/api/sale-receipts/' + receiptId, {
      headers: { Authorization: 'Bearer ' + token },
    })
    return r.json()
  }
  async function patchReceipt(data) {
    await page.request.patch(URL + '/api/sale-receipts/' + receiptId, {
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      data,
    })
  }

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
    originalItems = candidate.items || []
    originalAmounts = {
      subtotal: candidate.subtotal ?? null, tps: candidate.tps ?? null,
      tvq: candidate.tvq ?? null, other_taxes: candidate.other_taxes ?? null,
      total: candidate.total ?? null,
    }
  })

  after(async () => {
    if (receiptId && token) await patchReceipt({ items: originalItems, ...originalAmounts })
    await browser?.close()
  })

  test('éditer une taxe recompose le total = sous-total + taxes', async () => {
    // Base : 1 ligne à 100, TPS 5, TVQ 10, total 115.
    await patchReceipt({
      items: [{ description: 'E2E base', total: 100 }],
      subtotal: 100, tps: 5, tvq: 10, other_taxes: 0, total: 115,
    })
    await page.goto(URL + '/sale-receipts/' + receiptId, { waitUntil: 'networkidle' })

    const tps = page.getByTestId('receipt-amount-tps')
    await tps.waitFor({ state: 'visible', timeout: 10000 })
    await tps.fill('7')
    await tps.blur()
    await page.waitForTimeout(800)

    const r = await getReceipt()
    assert.equal(r.tps, 7, 'TPS persistée')
    assert.equal(r.total, 117, 'total recomposé = 100 + 7 + 10 + 0')
  })

  test('le Total est en lecture seule (dérivé, pas un champ éditable)', async () => {
    await page.goto(URL + '/sale-receipts/' + receiptId, { waitUntil: 'networkidle' })
    const el = page.getByTestId('receipt-amount-total')
    await el.waitFor({ state: 'visible', timeout: 10000 })
    const tag = await el.evaluate(node => node.tagName.toLowerCase())
    assert.notEqual(tag, 'input', 'le total dérivé ne doit pas être éditable')
    await assert.doesNotReject(
      page.locator('text=(articles + taxes)').waitFor({ state: 'visible', timeout: 3000 }),
      'l’indice « (articles + taxes) » doit être affiché'
    )
  })

  test('un total imprimé incohérent affiche le repère de divergence', async () => {
    // total stocké volontairement faux (200 alors que 100+5+10 = 115).
    await patchReceipt({
      items: [{ description: 'E2E base', total: 100 }],
      subtotal: 100, tps: 5, tvq: 10, other_taxes: 0, total: 200,
    })
    await page.goto(URL + '/sale-receipts/' + receiptId, { waitUntil: 'networkidle' })

    const totalEl = page.getByTestId('receipt-amount-total')
    await totalEl.waitFor({ state: 'visible', timeout: 10000 })
    const shown = await totalEl.textContent()
    assert.match(shown, /115/, 'le total affiché est le calcul articles + taxes (115)')
    await assert.doesNotReject(
      page.getByTestId('receipt-total-drift').waitFor({ state: 'visible', timeout: 3000 }),
      'le repère de divergence « reçu : … » doit apparaître'
    )
  })
})
