const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie la cascade : modifier le montant d'une ligne d'article recompose le
// sous-total (= somme des lignes), met les taxes à l'échelle du taux effectif
// actuel, et recompose le total. Le sous-total est alors affiché en lecture
// seule (dérivé des lignes).
//
// On part d'un état contrôlé (sous-total 100, TPS 5, TVQ 9,975) posé via API,
// on double une ligne dans le navigateur (100 → 200) et on attend TPS 10,
// TVQ 19,95, total 229,95. L'état d'origine est restauré dans after().

describe('Extraction de données : cascade lignes → sous-total / taxes / total', () => {
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

    // Sauvegarde de l'état d'origine pour restauration.
    originalItems = candidate.items || []
    originalAmounts = {
      subtotal: candidate.subtotal ?? null,
      tps: candidate.tps ?? null,
      tvq: candidate.tvq ?? null,
      other_taxes: candidate.other_taxes ?? null,
      total: candidate.total ?? null,
    }

    // État contrôlé : une ligne à 100, TPS 5, TVQ 9,975, total 114,975.
    await patchReceipt({
      items: [{ description: 'E2E base', total: 100 }],
      subtotal: 100, tps: 5, tvq: 9.975, other_taxes: 0, total: 114.975,
    })
  })

  after(async () => {
    if (receiptId && token) {
      await patchReceipt({ items: originalItems, ...originalAmounts })
    }
    await browser?.close()
  })

  test('doubler le total d\'une ligne double sous-total/taxes/total', async () => {
    await page.goto(URL + '/sale-receipts/' + receiptId, { waitUntil: 'networkidle' })
    const row = page.locator('[data-testid="receipt-item-row-0"]')
    await row.waitFor({ state: 'visible', timeout: 10000 })

    // Modifie le total de la ligne 0 : 100 → 200
    const amountInput = row.locator('input').nth(1)
    await amountInput.fill('200')
    await amountInput.blur()
    await page.waitForTimeout(1200)

    const r = await getReceipt()
    assert.equal(r.subtotal, 200, 'sous-total = somme des lignes')
    assert.equal(r.tps, 10, 'TPS mise à l\'échelle (5 → 10)')
    assert.equal(r.tvq, 19.95, 'TVQ mise à l\'échelle (9,975 → 19,95)')
    assert.equal(r.total, 229.95, 'total = sous-total + taxes')
  })

  test('le sous-total est affiché en lecture seule quand il y a des lignes', async () => {
    await page.goto(URL + '/sale-receipts/' + receiptId, { waitUntil: 'networkidle' })
    const el = page.getByTestId('receipt-amount-subtotal')
    await el.waitFor({ state: 'visible', timeout: 10000 })
    // En lecture seule c'est un <span>, pas un <input> éditable.
    const tag = await el.evaluate(node => node.tagName.toLowerCase())
    assert.notEqual(tag, 'input', 'le sous-total dérivé ne doit pas être un champ éditable')
    await assert.doesNotReject(
      page.locator('text=(somme des lignes)').waitFor({ state: 'visible', timeout: 3000 }),
      'l\'indice « (somme des lignes) » doit être affiché'
    )
  })
})
