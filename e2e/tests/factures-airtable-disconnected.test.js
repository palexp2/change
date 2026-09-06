const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Factures — Airtable sync déconnecté', () => {
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

  test('Le backfill amount_before_tax_cad est bien en place', async () => {
    await page.goto(URL + '/factures', { waitUntil: 'domcontentloaded' })
    const rows = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/projets/factures?limit=all', {
        headers: { Authorization: `Bearer ${token}` },
      })
      return r.json()
    })
    assert.ok(Array.isArray(rows.data), 'réponse doit contenir data[]')
    const withCad = rows.data.filter(f => Number(f.amount_before_tax_cad) !== 0)
    // Avant fix : ~91 lignes avaient cette valeur. Après backfill : ~2900.
    assert.ok(
      withCad.length > 500,
      `au moins 500 factures doivent avoir amount_before_tax_cad != 0 (trouvé ${withCad.length})`
    )
  })

  test("La page Connecteurs n'affiche plus d'onglet Factures", async () => {
    await page.goto(URL + '/connectors', { waitUntil: 'domcontentloaded' })
    // L'onglet "Factures" ne doit plus exister dans la nav de la config Airtable
    const count = await page.locator('button', { hasText: /^Factures$/ }).count()
    assert.equal(count, 0, 'aucun onglet "Factures" ne doit être présent dans la config Airtable')
  })

  test('montant_avant_taxes rempli pour tous les remboursements Stripe', async () => {
    const rows = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/projets/factures?limit=all', {
        headers: { Authorization: `Bearer ${token}` },
      })
      return r.json()
    })
    const refunds = rows.data.filter(f => f.sync_source === 'Remboursements Stripe')
    assert.ok(refunds.length > 0, 'au moins un remboursement Stripe attendu')
    const missing = refunds.filter(f => f.montant_avant_taxes == null)
    assert.equal(
      missing.length, 0,
      `tous les remboursements doivent avoir montant_avant_taxes (${missing.length} sans)`
    )
  })

  test('La route /api/connectors/sync/factures est absente', async () => {
    const status = await page.evaluate(async (url) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch(url + '/api/connectors/sync/factures', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      return r.status
    }, URL.replace(/\/erp$/, '/erp'))
    assert.equal(status, 404, 'la route doit renvoyer 404 après déconnexion')
  })
})
