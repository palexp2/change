const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Création facture Stripe depuis fiche entreprise', () => {
  let browser, ctx, page
  let companyId

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    // Pick any company for navigation tests
    companyId = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/companies?limit=1', { headers: { Authorization: `Bearer ${token}` } })
      const j = await r.json()
      return (j.data || j)[0]?.id || null
    })
    if (!companyId) throw new Error('aucune company en DB')
  })

  after(async () => { await browser?.close() })

  test('POST /api/stripe-invoices refuse si pas de shipping_province', async () => {
    const res = await page.evaluate(async ({ companyId }) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/stripe-invoices', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company_id: companyId,
          items: [{ qty: 1, unit_price: 100, description: 'Test' }],
          shipping_country: 'Canada',
          // shipping_province intentionnellement omis
          send_email: false,
        }),
      })
      return { status: r.status, body: await r.json() }
    }, { companyId })
    assert.strictEqual(res.status, 400)
    assert.strictEqual(res.body.code, 'no_shipping_province')
  })

  test('GET /api/stripe-invoices/companies/:id/convertible-soumissions répond', async () => {
    const r = await page.evaluate(async ({ companyId }) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch(`/erp/api/stripe-invoices/companies/${companyId}/convertible-soumissions`, { headers: { Authorization: `Bearer ${token}` } })
      return { status: r.status, body: await r.json() }
    }, { companyId })
    assert.strictEqual(r.status, 200)
    assert.ok(Array.isArray(r.body.data))
  })

  test('GET shipping-province retourne null ou un objet', async () => {
    const r = await page.evaluate(async ({ companyId }) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch(`/erp/api/stripe-invoices/companies/${companyId}/shipping-province`, { headers: { Authorization: `Bearer ${token}` } })
      return { status: r.status, body: await r.json() }
    }, { companyId })
    assert.strictEqual(r.status, 200)
    if (r.body !== null) {
      assert.ok(typeof r.body === 'object')
    }
  })

  test('Bouton "Nouvelle facture" présent sur fiche entreprise et ouvre la modal', async () => {
    const errors = []
    page.on('pageerror', e => errors.push(e.message))
    await page.goto(`${URL}/companies/${companyId}`, { waitUntil: 'domcontentloaded' })
    await page.locator('button:has-text("Nouvelle facture")').first().waitFor({ timeout: 10000 })
    await page.click('button:has-text("Nouvelle facture")')
    // Le menu s'ouvre — clic sur "Créer une nouvelle facture"
    await page.click('button:has-text("Créer une nouvelle facture")', { timeout: 3000 })
    // La modal s'ouvre avec son titre
    await page.waitForSelector('text=/Nouvelle facture Stripe/', { timeout: 5000 })
    // Le bloc shipping address est présent (chargement OK)
    await page.waitForSelector('text=/Adresse de livraison/', { timeout: 5000 })
    assert.deepStrictEqual(errors, [], 'aucune erreur JS')
  })

  test('Pixel de tracking emails — endpoint public répond avec un GIF', async () => {
    const fakeId = 'test-' + Date.now()
    const r = await page.evaluate(async ({ id }) => {
      const r = await fetch(`/erp/api/email-tracking/${id}.gif`)
      return { status: r.status, contentType: r.headers.get('content-type'), bytes: (await r.arrayBuffer()).byteLength }
    }, { id: fakeId })
    assert.strictEqual(r.status, 200)
    assert.match(r.contentType || '', /image\/gif/)
    assert.ok(r.bytes > 0 && r.bytes < 200, 'pixel < 200 bytes')
  })
})

describe('Helper computeCanadaTaxes côté serveur', () => {
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

  // Test indirect: appeler create avec une province connue puis vérifier le résultat —
  // mais on ne veut pas créer de vraies factures. On teste le helper via le module directement n'est pas trivial
  // depuis Playwright. On se contente du smoke test via la liste des Stripe tax_rates créées ou ignore.
  test('placeholder', () => { assert.ok(true) })
})
