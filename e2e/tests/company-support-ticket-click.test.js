const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Régression : dans la section Support d'une fiche entreprise, un clic sur
// un billet doit ouvrir la fiche du billet (/tickets/:id).
describe('CompanyDetail — clic sur un billet de support ouvre le ticket', () => {
  let browser, ctx, page, token, companyId, ticketId

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    token = await page.evaluate(() => localStorage.getItem('erp_token'))

    // Récupère une entreprise existante
    const company = await page.evaluate(async (tok) => {
      const r = await fetch('/erp/api/companies?limit=1', { headers: { Authorization: `Bearer ${tok}` } })
      const j = await r.json()
      return (j.companies || j.data || j)[0]
    }, token)
    assert.ok(company?.id, 'devrait trouver au moins une entreprise')
    companyId = company.id

    // Crée un billet dédié pour le test
    const res = await page.evaluate(async ({ tok, cid }) => {
      const r = await fetch('/erp/api/tickets', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ company_id: cid, title: `E2E click ticket ${Date.now()}`, type: 'Support', status: 'Waiting on us' }),
      })
      return { status: r.status, data: await r.json() }
    }, { tok: token, cid: companyId })
    assert.equal(res.status, 201, `create ticket: ${JSON.stringify(res.data)}`)
    ticketId = res.data.id
  })

  after(async () => {
    if (ticketId) {
      await page.evaluate(async ({ tok, id }) => {
        await fetch(`/erp/api/tickets/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${tok}` } })
      }, { tok: token, id: ticketId })
    }
    await browser?.close()
  })

  test('clic sur la ligne du billet navigue vers /tickets/:id', async () => {
    await page.goto(`${URL}/companies/${companyId}`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle')

    // Ouvre l'onglet Support
    await page.click('button:has-text("support")')

    // La ligne du billet doit être présente puis cliquable
    const row = page.locator(`tr:has-text("E2E click ticket")`).first()
    await row.waitFor({ state: 'visible', timeout: 5000 })

    // Le curseur doit indiquer que la ligne est cliquable
    const cursor = await row.evaluate(el => getComputedStyle(el).cursor)
    assert.equal(cursor, 'pointer', 'la ligne doit avoir cursor:pointer')

    await row.click()
    await page.waitForURL(u => u.toString().includes(`/tickets/${ticketId}`), { timeout: 5000 })
    assert.ok(page.url().includes(`/tickets/${ticketId}`), `URL actuelle: ${page.url()}`)
  })
})
