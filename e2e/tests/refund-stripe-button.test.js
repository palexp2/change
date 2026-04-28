const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Bouton « Voir sur Stripe » sur les remboursements', () => {
  let browser, ctx, page
  let stripeNativeRefund, airtableRefund

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    // Fetch refund factures using the in-page session token
    const rows = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const res = await fetch('/erp/api/projets/factures?sync_source=Remboursements%20Stripe&limit=200', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const json = await res.json()
      return json.data || []
    })

    stripeNativeRefund = rows.find(r => !r.airtable_id && r.invoice_id?.startsWith('re_'))
    airtableRefund = rows.find(r => r.airtable_id && r.invoice_id?.startsWith('ch_'))
    if (!stripeNativeRefund) throw new Error('Aucun refund Stripe-natif trouvé (re_xxx, airtable_id NULL)')
  })

  after(async () => { await browser?.close() })

  test('refund Stripe-natif (re_xxx) — bouton visible avec deep-link /refunds/', async () => {
    await page.goto(`${URL}/factures/${stripeNativeRefund.id}`, { waitUntil: 'networkidle' })
    await page.waitForSelector('h1', { timeout: 10000 })

    const link = page.locator('a[title="Ouvrir dans Stripe"]')
    assert.ok(await link.isVisible(), 'bouton Stripe absent')

    const href = await link.getAttribute('href')
    assert.match(
      href,
      new RegExp(`^https://dashboard\\.stripe\\.com/refunds/${stripeNativeRefund.invoice_id}$`),
      `href incorrect: ${href}`,
    )

    const text = await link.textContent()
    assert.match(text, /Stripe/, `libellé incorrect: ${text}`)
  })

  test('refund Airtable historique (ch_xxx) — bouton visible avec deep-link /payments/', async () => {
    if (!airtableRefund) {
      // Données absentes : skip plutôt qu'échec
      return
    }
    await page.goto(`${URL}/factures/${airtableRefund.id}`, { waitUntil: 'networkidle' })
    await page.waitForSelector('h1', { timeout: 10000 })

    const link = page.locator('a[title="Ouvrir dans Stripe"]')
    assert.ok(await link.isVisible(), 'bouton Stripe absent')

    const href = await link.getAttribute('href')
    assert.match(
      href,
      new RegExp(`^https://dashboard\\.stripe\\.com/payments/${airtableRefund.invoice_id}$`),
      `href incorrect: ${href}`,
    )
  })

  test('badge « Remboursement » présent', async () => {
    await page.goto(`${URL}/factures/${stripeNativeRefund.id}`, { waitUntil: 'networkidle' })
    await page.waitForSelector('h1', { timeout: 10000 })
    assert.ok(
      await page.locator('text=Remboursement').first().isVisible(),
      'badge Remboursement absent',
    )
  })
})
