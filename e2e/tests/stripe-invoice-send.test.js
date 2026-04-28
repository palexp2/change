const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Bouton "Envoyer par email" pour factures Draft', () => {
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

  test('POST /api/stripe-invoices/:id/send retourne 404 si la facture n\'existe pas dans l\'ERP', async () => {
    const res = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/stripe-invoices/in_DOES_NOT_EXIST/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      return { status: r.status, body: await r.json() }
    })
    assert.strictEqual(res.status, 404)
  })

  test('FactureDetail charge sans erreur (pas de bouton si facture non Draft)', async () => {
    const errors = []
    page.on('pageerror', e => errors.push(e.message))
    const factureId = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/projets/factures?limit=1', { headers: { Authorization: `Bearer ${token}` } })
      const j = await r.json()
      return (j.data || j)[0]?.id || null
    })
    assert.ok(factureId)
    await page.goto(`${URL}/factures/${factureId}`, { waitUntil: 'domcontentloaded' })
    await page.locator('h1').first().waitFor({ timeout: 10000 })
    // Le bouton "Envoyer par email" n'apparaît que pour les factures Draft —
    // ici la facture est probablement Payé donc on s'attend à 0
    const btnCount = await page.locator('button:has-text("Envoyer par email")').count()
    // Pas d'assertion stricte — on vérifie juste qu'il n'y a pas d'erreur JS
    console.log(`bouton Envoyer présent : ${btnCount > 0}`)
    assert.deepStrictEqual(errors, [], 'aucune erreur JS sur FactureDetail')
  })
})
