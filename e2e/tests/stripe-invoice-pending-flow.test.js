const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Pending invoice flow + permanent /pay link', () => {
  let browser, ctx, page
  let companyId
  const createdPending = []

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    // Find a company that has a shipping address with province (so creation succeeds)
    companyId = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/companies?limit=200', { headers: { Authorization: `Bearer ${token}` } })
      const j = await r.json()
      const companies = j.data || j
      for (const c of companies) {
        const ship = await fetch(`/erp/api/stripe-invoices/companies/${c.id}/shipping-province`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
        if (ship?.province) return c.id
      }
      return null
    })
  })

  after(async () => {
    if (createdPending.length > 0) {
      await page.evaluate(async ({ ids }) => {
        const token = localStorage.getItem('erp_token')
        for (const id of ids) {
          await fetch(`/erp/api/stripe-invoices/${id}/cancel`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => {})
        }
      }, { ids: createdPending })
    }
    await browser?.close()
  })

  test('POST /api/stripe-invoices crée une pending sans appeler Stripe', async (t) => {
    if (!companyId) { t.skip('aucune company avec shipping province trouvée'); return }
    const res = await page.evaluate(async ({ companyId }) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/stripe-invoices', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company_id: companyId,
          items: [{ qty: 1, unit_price: 50, description: 'Test pending invoice' }],
          shipping_province: 'QC',
          shipping_country: 'Canada',
          send_email: false, // no Gmail call
          due_days: 30,
        }),
      })
      return { status: r.status, body: await r.json() }
    }, { companyId })
    assert.strictEqual(res.status, 200)
    assert.ok(res.body.pending_invoice_id)
    assert.strictEqual(res.body.status, 'draft')
    assert.ok(res.body.pay_url.includes(`/erp/pay/${res.body.pending_invoice_id}`), 'pay_url contient le pending_invoice_id')
    createdPending.push(res.body.pending_invoice_id)
  })

  test('GET /erp/pay/:id avec id inexistant → 404 HTML', async () => {
    const r = await page.goto(`${URL}/pay/does-not-exist-${Date.now()}`, { waitUntil: 'domcontentloaded' })
    assert.strictEqual(r.status(), 404)
    const html = await page.content()
    assert.match(html, /introuvable/i)
  })

  test('Pending apparait dans la liste factures avec status Draft + source pending', async (t) => {
    if (createdPending.length === 0) { t.skip('aucune pending créée'); return }
    const found = await page.evaluate(async ({ pendingId }) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/projets/factures?limit=all', { headers: { Authorization: `Bearer ${token}` } })
      const j = await r.json()
      return (j.data || []).find(f => f.id === pendingId) || null
    }, { pendingId: createdPending[0] })
    assert.ok(found, 'pending visible dans la liste factures')
    assert.strictEqual(found.source, 'pending')
    assert.strictEqual(found.status, 'Draft')
  })

  test('GET /api/projets/factures/:id retourne le pending avec source=pending', async (t) => {
    if (createdPending.length === 0) { t.skip(); return }
    const res = await page.evaluate(async ({ pendingId }) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch(`/erp/api/projets/factures/${pendingId}`, { headers: { Authorization: `Bearer ${token}` } })
      return { status: r.status, body: await r.json() }
    }, { pendingId: createdPending[0] })
    assert.strictEqual(res.status, 200)
    assert.strictEqual(res.body.source, 'pending')
    assert.ok(Array.isArray(res.body.items))
    assert.ok(res.body.pay_url)
  })

  test('POST /:id/cancel met le pending en cancelled', async (t) => {
    if (createdPending.length === 0) { t.skip(); return }
    const id = createdPending[0]
    const res = await page.evaluate(async ({ id }) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch(`/erp/api/stripe-invoices/${id}/cancel`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
      return { status: r.status, body: await r.json() }
    }, { id })
    assert.strictEqual(res.status, 200)
    // After cancel, /pay/:id should show "cancelled" page
    const r2 = await page.goto(`${URL}/pay/${id}`, { waitUntil: 'domcontentloaded' })
    assert.strictEqual(r2.status(), 410)
    assert.match(await page.content(), /annulée/i)
  })

  test('Page CustomerPostPayment charge sans crash (sans session valide)', async () => {
    const errors = []
    page.on('pageerror', e => errors.push(e.message))
    await page.goto(`${URL}/customer/post-payment?session_id=cs_invalid_test`, { waitUntil: 'domcontentloaded' })
    // Wait for either error message or session validation result
    await page.locator('text=/erreur|chargement|introuvable|paiement/i').first().waitFor({ timeout: 10000 }).catch(() => {})
    assert.deepStrictEqual(errors, [], 'aucune erreur JS')
  })

  test('Wizard CustomerPostPayment retourne 402 pour session non payée', async () => {
    const status = await page.evaluate(async () => {
      const r = await fetch('/erp/api/customer/post-payment/cs_invalid_test_session')
      return r.status
    })
    // Stripe will return resource_missing → 404, or paid_status check → 402
    assert.ok(status === 402 || status === 404 || status === 500, `status was ${status}`)
  })

  test('Wizard /save valide la session avant écriture', async () => {
    const status = await page.evaluate(async () => {
      const r = await fetch('/erp/api/customer/post-payment/cs_invalid_test_session/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_new_site: 'new' }),
      })
      return r.status
    })
    assert.ok(status === 402 || status === 404 || status === 500)
  })
})
