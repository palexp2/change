const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// La note explicative sous la liste d'articles (« Laissez « Code du document »… »)
// a été retirée à la demande de l'utilisateur. Test en lecture seule : aucun record
// créé ni modifié.

describe('Reçu de vente : la note explicative des codes de taxe est retirée', () => {
  let browser, ctx, page
  let receiptId

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
    const resp = await page.request.get(URL + '/api/sale-receipts?limit=all', {
      headers: { Authorization: 'Bearer ' + token },
    })
    const body = await resp.json()
    const candidate = body.data.find(r => r.status === 'done') || body.data[0]
    assert.ok(candidate, 'Préalable : au moins un reçu de vente est requis')
    receiptId = candidate.id
  })

  after(async () => {
    await browser?.close()
  })

  test('la fiche affiche les articles sans la note « Laissez « Code du document » »', async () => {
    await page.goto(URL + '/sale-receipts/' + receiptId, { waitUntil: 'networkidle' })
    // La section Articles est bien rendue (le bloc d'où la note a été retirée).
    await page.getByTestId('receipt-item-add').waitFor({ state: 'visible', timeout: 15000 })

    const bodyText = await page.locator('#root').innerText()
    assert.ok(
      !bodyText.includes('Laissez'),
      'La note « Laissez « Code du document »… » ne doit plus apparaître sur la fiche',
    )
    assert.ok(
      !bodyText.includes('Choisissez un code par ligne'),
      'La suite de la note ne doit plus apparaître non plus',
    )
  })
})
