const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Cleanup queue QB Stripe — UI/API encore fonctionnels', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => { await browser?.close() })

  test('routes queue retirées renvoient 404', async () => {
    const res = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const h = { Authorization: `Bearer ${token}` }
      const list = await fetch('/erp/api/stripe-queue', { headers: h })
      const unique = await fetch('/erp/api/stripe-queue/tax-rates/unique', { headers: h })
      const approve = await fetch('/erp/api/stripe-queue/foo/approve', { method: 'POST', headers: h })
      return { list: list.status, unique: unique.status, approve: approve.status }
    })
    assert.strictEqual(res.list, 404, 'GET /stripe-queue (list) doit être 404')
    assert.strictEqual(res.unique, 404, 'GET /stripe-queue/tax-rates/unique doit être 404')
    assert.strictEqual(res.approve, 404, 'POST /stripe-queue/:id/approve doit être 404')
  })

  test('routes conservées (tax-mappings, batch-enrich) répondent', async () => {
    const res = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const h = { Authorization: `Bearer ${token}` }
      const list = await fetch('/erp/api/stripe-queue/tax-mappings/list', { headers: h })
      const status = await fetch('/erp/api/stripe-queue/batch-enrich/status', { headers: h })
      return { list: list.status, status: status.status }
    })
    assert.strictEqual(res.list, 200, 'tax-mappings/list doit être 200')
    assert.strictEqual(res.status, 200, 'batch-enrich/status doit être 200')
  })

  test('TaxMappingModal s\'ouvre et liste les mappings sans erreur JS', async () => {
    const errors = []
    page.on('pageerror', e => errors.push(e.message))
    await page.goto(`${URL}/connectors`, { waitUntil: 'networkidle' })
    const btn = page.locator('button', { hasText: 'Taxes Stripe → QB' })
    if (await btn.count() === 0) {
      // QB pas connecté → bouton absent. On teste alors juste que la page charge sans crash.
      assert.deepStrictEqual(errors, [], 'aucune erreur JS sur Connectors')
      return
    }
    await btn.first().click()
    await page.waitForSelector('text=/Taxes Stripe → QuickBooks/', { timeout: 5000 })
    await page.waitForSelector('text=/Mappings actifs/', { timeout: 3000 })
    assert.deepStrictEqual(errors, [], 'aucune erreur JS')
  })

  test('FactureDetail charge sans erreur (badges QB queue retirés)', async () => {
    const errors = []
    page.on('pageerror', e => errors.push(e.message))
    const factureId = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/projets/factures?limit=1', { headers: { Authorization: `Bearer ${token}` } })
      const j = await r.json()
      return (j.data || j)[0]?.id || null
    })
    assert.ok(factureId, 'au moins une facture doit exister pour tester FactureDetail')
    await page.goto(`${URL}/factures/${factureId}`, { waitUntil: 'networkidle' })
    await page.waitForSelector('h1, h2, [class*="text-xl"], [class*="text-2xl"]', { timeout: 5000 })
    // Aucune mention de "QB #" ou "QB erreur" ne doit apparaître
    const qbBadge = await page.locator('text=/QB #|QB erreur/').count()
    assert.strictEqual(qbBadge, 0, 'pas de badge qb_queue_status')
    assert.deepStrictEqual(errors, [], 'aucune erreur JS sur FactureDetail')
  })
})
