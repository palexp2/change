const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('TicketDetail — pas de lien entreprise dans le header', () => {
  let browser, ctx, page
  let ticketId, companyId

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    const ids = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      const company = await fetch('/erp/api/companies', {
        method: 'POST', headers,
        body: JSON.stringify({ name: `__hdr_test_co_${Date.now()}` }),
      }).then(r => r.json())
      const ticket = await fetch('/erp/api/tickets', {
        method: 'POST', headers,
        body: JSON.stringify({ title: `__hdr_test_${Date.now()}`, status: 'Waiting on us', company_id: company.id }),
      }).then(r => r.json())
      return { ticketId: ticket.id, companyId: company.id }
    })
    ticketId = ids.ticketId
    companyId = ids.companyId
  })

  after(async () => {
    await page.evaluate(async ({ ticketId, companyId }) => {
      const token = localStorage.getItem('erp_token')
      const h = { Authorization: `Bearer ${token}` }
      if (ticketId) await fetch(`/erp/api/tickets/${ticketId}`, { method: 'DELETE', headers: h })
      if (companyId) await fetch(`/erp/api/companies/${companyId}`, { method: 'DELETE', headers: h })
    }, { ticketId, companyId })
    await browser?.close()
  })

  test("le header n'expose plus de lien direct vers l'entreprise", async () => {
    await page.goto(`${URL}/tickets/${ticketId}`, { waitUntil: 'networkidle' })
    await page.waitForSelector('h1', { timeout: 5000 })
    // Header = bloc qui contient le h1 du titre
    const header = page.locator('h1').locator('..')
    const headerHrefs = await header.locator(`a[href*="/companies/${companyId}"]`).count()
    assert.strictEqual(headerHrefs, 0, "le header ne doit plus contenir de lien vers l'entreprise")

    // Le lien standard via LinkedRecordField doit, lui, être présent ailleurs sur la page
    const standard = page.locator(`[data-testid="linked-record-field-company_id"] a[href*="/companies/${companyId}"]`)
    await standard.first().waitFor({ state: 'visible', timeout: 3000 })
  })
})
