const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Déplacement du mapping taxes Stripe → QB', () => {
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

  test("La page Factures n'affiche plus le bouton Taxes Stripe → QB", async () => {
    await page.goto(URL + '/factures', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=Factures clients', { timeout: 10000 })
    const count = await page.locator('button:has-text("Taxes Stripe → QB")').count()
    assert.equal(count, 0, 'Le bouton "Taxes Stripe → QB" ne doit plus apparaître sur la page Factures')
  })

  test('La section Connecteurs → QuickBooks affiche le bouton Taxes Stripe → QB', async () => {
    await page.goto(URL + '/connectors', { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1000)
    // Déplier la section QuickBooks
    const qbHeader = page.locator('button:has-text("QuickBooks")').first()
    await qbHeader.click()
    await page.waitForTimeout(500)
    const btn = page.locator('button:has-text("Taxes Stripe → QB")')
    await btn.waitFor({ state: 'visible', timeout: 5000 })
    // Ouvre le modal pour vérifier qu'il se charge
    await btn.click()
    const modalTitle = page.locator('text=Taxes Stripe → QuickBooks').first()
    await modalTitle.waitFor({ state: 'visible', timeout: 5000 })
  })

  test("Le détail d'une facture n'affiche plus le bouton Publier sur QB", async () => {
    // Récupérer une facture Stripe (invoice_id commence par 'in_')
    const invoiceId = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/projets/factures?limit=all', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const d = await r.json()
      const stripe = (d.data || []).find(f => f.invoice_id && f.invoice_id.startsWith('in_'))
      return stripe?.id || null
    })
    assert.ok(invoiceId, 'au moins une facture Stripe doit exister pour le test')

    await page.goto(URL + '/factures/' + invoiceId, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)
    const count = await page.locator('button:has-text("Publier sur QB")').count()
    assert.equal(count, 0, 'Le bouton "Publier sur QB" ne doit plus apparaître sur FactureDetail')
  })

  test("La route backend /api/projets/factures/:id/push-qb n'existe plus", async () => {
    const invoiceId = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/projets/factures?limit=1', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const d = await r.json()
      return d.data?.[0]?.id || null
    })
    assert.ok(invoiceId, 'au moins une facture doit exister pour le test')

    const status = await page.evaluate(async (id) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch(`/erp/api/projets/factures/${id}/push-qb`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      return r.status
    }, invoiceId)
    assert.equal(status, 404, 'la route /push-qb doit renvoyer 404')
  })
})
