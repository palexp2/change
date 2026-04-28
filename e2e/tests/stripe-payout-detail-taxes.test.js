const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Détail payout Stripe — colonnes taxes vente/frais', () => {
  let browser, ctx, page
  let payoutWithTx

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    // Pick the most recent payout that has synced balance_transactions.
    payoutWithTx = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const res = await fetch('/erp/api/stripe-payouts?limit=20', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const { data } = await res.json()
      // Scan in parallel, return first hit
      const results = await Promise.all(data.map(async p => {
        const d = await fetch(`/erp/api/stripe-payouts/${p.stripe_id}`, {
          headers: { Authorization: `Bearer ${token}` },
        }).then(r => r.json())
        return d.transactions?.length ? p.stripe_id : null
      }))
      return results.find(Boolean) || null
    })
    if (!payoutWithTx) throw new Error('Aucun payout avec transactions synchronisées dans les 20 plus récents')
  })

  after(async () => { await browser?.close() })

  test('table des transactions affiche les colonnes Tx. vente et Tx. frais', async () => {
    await page.goto(`${URL}/stripe-payouts/${payoutWithTx}`, { waitUntil: 'networkidle' })
    await page.waitForSelector('table', { timeout: 10000 })

    const headers = await page.$$eval('table thead th', ths => ths.map(th => th.textContent.trim()))
    assert.ok(headers.includes('Tx. vente'), `En-tête Tx. vente absent — reçu: ${headers.join(' | ')}`)
    assert.ok(headers.includes('Tx. frais'), `En-tête Tx. frais absent — reçu: ${headers.join(' | ')}`)
    assert.ok(!headers.includes('Type de taxe'), `Ancienne colonne "Type de taxe" encore présente`)

    const rowCount = await page.locator('table tbody tr').count()
    assert.ok(rowCount > 0, 'aucune ligne de transaction rendue')
  })
})
