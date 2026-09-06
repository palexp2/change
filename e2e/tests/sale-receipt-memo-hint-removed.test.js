const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// La note explicative sous « Description principale » (« Envoyée comme « Memo »
// dans QuickBooks… ») a été retirée à la demande de l'utilisateur.
// Test en lecture seule : aucun record créé ni modifié.

describe('Reçu de vente : la note explicative sous la description principale est retirée', () => {
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

  test('la fiche affiche la description principale sans la note « Envoyée comme « Memo » »', async () => {
    await page.goto(URL + '/sale-receipts/' + receiptId, { waitUntil: 'networkidle' })
    // Le champ dont la note a été retirée est bien rendu.
    await page.getByTestId('receipt-general-description').waitFor({ state: 'visible', timeout: 15000 })

    const bodyText = await page.locator('#root').innerText()
    assert.ok(
      !bodyText.includes('Envoyée comme'),
      'La note « Envoyée comme « Memo » dans QuickBooks… » ne doit plus apparaître sur la fiche',
    )
    assert.ok(
      !bodyText.includes('la période couverte est intégrée directement ici'),
      'La suite de la note ne doit plus apparaître non plus',
    )
  })
})
