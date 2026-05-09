const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Détail payout Stripe — transactions triées par type', () => {
  let browser, ctx, page
  let payoutWithMixed

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    // Find a payout with at least 2 distinct types so we can assert grouping.
    payoutWithMixed = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const res = await fetch('/erp/api/stripe-payouts?limit=30', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const { data } = await res.json()
      for (const p of data) {
        const d = await fetch(`/erp/api/stripe-payouts/${p.stripe_id}`, {
          headers: { Authorization: `Bearer ${token}` },
        }).then(r => r.json())
        if (!d.transactions?.length) continue
        const types = new Set(d.transactions.map(t => t.type))
        if (types.size >= 2) return p.stripe_id
      }
      return null
    })
    if (!payoutWithMixed) throw new Error('Aucun payout avec ≥2 types de transactions trouvé')
  })

  after(async () => { await browser?.close() })

  test('lignes du même type sont contiguës', async () => {
    await page.goto(`${URL}/stripe-payouts/${payoutWithMixed}`, { waitUntil: 'networkidle' })
    await page.waitForSelector('table tbody tr', { timeout: 10000 })

    // Type label is the second column, rendered inside a pill span.
    const typeLabels = await page.$$eval('table tbody tr', trs =>
      trs.map(tr => tr.querySelectorAll('td')[1]?.textContent.replace(/\s+/g, ' ').trim() || '')
    )
    assert.ok(typeLabels.length >= 2, `attendu ≥2 lignes, reçu ${typeLabels.length}`)

    // Walk rows: each label should appear in one contiguous run.
    const seenAndClosed = new Set()
    let current = null
    for (const label of typeLabels) {
      if (label !== current) {
        assert.ok(!seenAndClosed.has(label), `Type "${label}" réapparaît après avoir été interrompu — table non groupée: ${JSON.stringify(typeLabels)}`)
        if (current !== null) seenAndClosed.add(current)
        current = label
      }
    }
  })
})
