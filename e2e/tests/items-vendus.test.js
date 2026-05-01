const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Items vendus — page comptabilité', () => {
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

  test('La route /items-vendus charge sans erreur et affiche le titre', async () => {
    const errors = []
    page.on('pageerror', e => errors.push(e.message))
    page.on('response', r => {
      if (r.url().includes('/api/stripe-invoice-items') && !r.ok() && r.status() !== 401) {
        errors.push(`API ${r.status()} ${r.url()}`)
      }
    })

    await page.goto(URL + '/items-vendus', { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)

    const heading = await page.locator('h1', { hasText: 'Items vendus' }).count()
    assert.ok(heading > 0, 'titre "Items vendus" doit être affiché')

    assert.equal(errors.length, 0, `pas d'erreur attendue, vu : ${errors.join(' | ')}`)
  })

  test('API list renvoie data[] avec champs attendus', async () => {
    await page.goto(URL + '/items-vendus', { waitUntil: 'domcontentloaded' })
    const json = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/stripe-invoice-items?limit=10', {
        headers: { Authorization: `Bearer ${token}` },
      })
      return { status: r.status, body: await r.json() }
    })
    assert.equal(json.status, 200, 'GET /api/stripe-invoice-items doit retourner 200')
    assert.ok(Array.isArray(json.body.data), 'réponse doit contenir data[]')
    assert.ok(typeof json.body.total === 'number', 'réponse doit contenir total (number)')
  })

  test('Entrée nav "Items vendus" présente dans la sidebar Comptabilité', async () => {
    // En naviguant sur /items-vendus, le groupe Comptabilité s'ouvre automatiquement
    // (NavGroup détecte que la route active est dans ses items et set open=true).
    await page.goto(URL + '/items-vendus', { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(500)
    const link = await page.locator('a[href*="/items-vendus"]').count()
    assert.ok(link > 0, 'lien nav vers /items-vendus attendu')
  })
})
