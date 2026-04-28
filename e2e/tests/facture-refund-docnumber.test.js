const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('FactureDetail — remboursement avec numéro "-R"', () => {
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

  test("Un remboursement avec un numéro se termine par '-R' et l'affiche dans le header", async () => {
    await page.goto(URL + '/factures', { waitUntil: 'domcontentloaded' })
    const refund = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/projets/factures?limit=all', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const j = await r.json()
      return (j.data || []).find(f => f.status === 'Remboursement' && f.document_number)
    })
    assert.ok(refund, "au moins un remboursement avec document_number est attendu")
    assert.match(refund.document_number, /-R$/, `document_number doit finir par -R (reçu: ${refund.document_number})`)

    await page.goto(URL + '/factures/' + refund.id, { waitUntil: 'domcontentloaded' })
    const h1 = page.locator('h1')
    await h1.waitFor({ state: 'visible', timeout: 10000 })
    const title = await h1.innerText()
    assert.equal(title, refund.document_number, `le h1 doit afficher le document_number (reçu: ${title})`)
  })
})
