const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie le composant <LinkedRecordField> sur TicketDetail (company_id)
// État vide : petit bouton gris (data-testid="linked-record-add")
// Ouvert   : portail dropdown recherchable
// Sélectionné : chip <Link> cliquable + bouton x pour délier
describe('LinkedRecordField — TicketDetail (Entreprise)', () => {
  let browser, ctx, page, token, ticketId, company
  const FIELD = '[data-testid="linked-record-field-company_id"]'

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

    company = await page.evaluate(async (tok) => {
      const r = await fetch('/erp/api/companies?limit=1', { headers: { Authorization: `Bearer ${tok}` } })
      const j = await r.json()
      return (j.companies || j.data || j)[0]
    }, token)
    assert.ok(company?.id, 'une entreprise doit exister pour le test')

    const res = await page.evaluate(async (tok) => {
      const r = await fetch('/erp/api/tickets', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: `LinkedRecordField test ${Date.now()}`, status: 'Ouvert' }),
      })
      return { status: r.status, data: await r.json() }
    }, token)
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

  test('État vide — petit bouton gris visible, data-state="empty"', async () => {
    await page.goto(`${URL}/tickets/${ticketId}`, { waitUntil: 'networkidle' })
    const field = page.locator(FIELD)
    await field.waitFor({ timeout: 10000 })
    assert.equal(await field.getAttribute('data-state'), 'empty', 'état initial doit être vide')
    await field.locator('[data-testid="linked-record-add"]').waitFor({ timeout: 5000 })
  })

  test('Ouverture — dropdown portail avec input de recherche', async () => {
    await page.goto(`${URL}/tickets/${ticketId}`, { waitUntil: 'networkidle' })
    const field = page.locator(FIELD)
    await field.locator('[data-testid="linked-record-add"]').click()
    const portal = page.locator('#linked-record-portal')
    await portal.waitFor({ timeout: 5000 })
    await portal.locator('input[placeholder="Rechercher..."]').waitFor({ timeout: 2000 })
  })

  test('Sélection — chip affiche le nom, état "selected", autosave en DB', async () => {
    await page.goto(`${URL}/tickets/${ticketId}`, { waitUntil: 'networkidle' })
    const field = page.locator(FIELD)
    await field.locator('[data-testid="linked-record-add"]').click()
    const portal = page.locator('#linked-record-portal')
    await portal.waitFor({ timeout: 5000 })
    await portal.locator('input[placeholder="Rechercher..."]').fill(company.name.slice(0, Math.min(6, company.name.length)))
    await portal.locator('button', { hasText: company.name }).first().click()

    await page.waitForFunction(
      sel => {
        const el = document.querySelector(sel)
        return el && el.getAttribute('data-state') === 'selected'
      },
      FIELD,
      { timeout: 5000 }
    )
    const linkText = await field.locator('[data-testid="linked-record-link"]').innerText()
    assert.equal(linkText.trim(), company.name, 'chip doit afficher le nom de l\'entreprise')
    const href = await field.locator('[data-testid="linked-record-link"]').getAttribute('href')
    assert.ok(href.endsWith(`/companies/${company.id}`), `href doit pointer vers /companies/${company.id}, got ${href}`)

    const fresh = await page.evaluate(async ({ tok, id }) => {
      const r = await fetch(`/erp/api/tickets/${id}`, { headers: { Authorization: `Bearer ${tok}` } })
      return r.json()
    }, { tok: token, id: ticketId })
    assert.equal(fresh.company_id, company.id, 'company_id persisté en DB')
  })

  test('Clic sur le chip → navigation vers /companies/:id', async () => {
    await page.goto(`${URL}/tickets/${ticketId}`, { waitUntil: 'networkidle' })
    const field = page.locator(FIELD)
    await field.waitFor({ timeout: 5000 })
    assert.equal(await field.getAttribute('data-state'), 'selected', 'doit être en état sélectionné')
    await field.locator('[data-testid="linked-record-link"]').click()
    await page.waitForURL(new RegExp(`/companies/${company.id}`), { timeout: 5000 })
  })

  test('Clic sur le x → délie (retour état vide) et efface en DB', async () => {
    await page.goto(`${URL}/tickets/${ticketId}`, { waitUntil: 'networkidle' })
    const field = page.locator(FIELD)
    await field.waitFor({ timeout: 5000 })
    await field.locator('[data-testid="linked-record-clear"]').click()
    await page.waitForFunction(
      sel => {
        const el = document.querySelector(sel)
        return el && el.getAttribute('data-state') === 'empty'
      },
      FIELD,
      { timeout: 5000 }
    )
    const fresh = await page.evaluate(async ({ tok, id }) => {
      const r = await fetch(`/erp/api/tickets/${id}`, { headers: { Authorization: `Bearer ${tok}` } })
      return r.json()
    }, { tok: token, id: ticketId })
    assert.equal(fresh.company_id, null, 'company_id doit être null en DB')
  })
})
