// Cliquer une ligne de l'onglet Factures de la fiche entreprise doit ouvrir
// la fiche détail de cette facture.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('CompanyDetail — clic sur ligne facture ouvre le détail', () => {
  let browser, ctx, page, companyId, factureId, factureDoc

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    // Trouve une facture liée à une entreprise (avec un document_number non null)
    const found = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/projets/factures?limit=all', { headers: { Authorization: `Bearer ${tok}` } })
      const j = await r.json()
      const f = (j.data || []).find(x => x.company_id && x.document_number && x.source === 'stripe')
      return f || null
    })
    assert.ok(found, 'devrait trouver une facture avec company_id + document_number')
    companyId = found.company_id
    factureId = found.id
    factureDoc = found.document_number
  })

  after(async () => { await browser?.close() })

  test('clic sur une ligne de l\'onglet Factures navigue vers /factures/:id', async () => {
    await page.goto(`${URL}/companies/${companyId}`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle')

    await page.click('button:has-text("factures")')
    await page.locator('th:has-text("N° document")').waitFor({ state: 'visible', timeout: 5000 })

    // Cible la ligne correspondant au document_number connu
    const row = page.locator('table tbody tr', { hasText: factureDoc }).first()
    await row.waitFor({ state: 'visible', timeout: 5000 })

    // Vérifie que le curseur est pointer (affordance visuelle)
    const cursor = await row.evaluate(el => getComputedStyle(el).cursor)
    assert.equal(cursor, 'pointer', `la ligne devrait avoir cursor:pointer, got ${cursor}`)

    await row.click()
    await page.waitForURL(u => u.toString().includes(`/factures/${factureId}`), { timeout: 10000 })

    // Sanity check : la fiche détail est bien rendue
    await page.locator('h1', { hasText: factureDoc }).waitFor({ state: 'visible', timeout: 10000 })
  })
})
