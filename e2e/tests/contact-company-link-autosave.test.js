const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Régression : PUT /api/contacts/:id avec uniquement { company_id } échouait
// avec "NOT NULL constraint failed: contacts.first_name" parce que la route
// faisait un UPDATE complet qui mettait first_name=NULL quand le champ n'était
// pas fourni. La route est maintenant un vrai partial update.
describe('Contacts — lier une entreprise ne casse pas first_name/last_name', () => {
  let browser, ctx, page, token, contactId

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
    // Créer un contact dédié pour le test
    const res = await page.evaluate(async (tok) => {
      const r = await fetch('/erp/api/contacts', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ first_name: 'Autosave', last_name: 'Test', email: `autosave-${Date.now()}@test.local` }),
      })
      return { status: r.status, data: await r.json() }
    }, token)
    assert.equal(res.status, 201, `create contact: ${JSON.stringify(res.data)}`)
    contactId = res.data.id
  })

  after(async () => {
    if (contactId) {
      await page.evaluate(async ({ tok, id }) => {
        await fetch(`/erp/api/contacts/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${tok}` } })
      }, { tok: token, id: contactId })
    }
    await browser?.close()
  })

  test('PUT partiel avec seulement company_id préserve first_name/last_name', async () => {
    // Récupère une entreprise quelconque
    const company = await page.evaluate(async (tok) => {
      const r = await fetch('/erp/api/companies?limit=1', { headers: { Authorization: `Bearer ${tok}` } })
      const j = await r.json()
      return (j.companies || j.data || j)[0]
    }, token)
    assert.ok(company?.id, 'devrait trouver au moins une entreprise')

    // Appel PUT avec seulement { company_id } — le bug déclenchait NOT NULL ici
    const result = await page.evaluate(async ({ tok, id, cid }) => {
      const r = await fetch(`/erp/api/contacts/${id}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ company_id: cid }),
      })
      return { status: r.status, data: await r.json() }
    }, { tok: token, id: contactId, cid: company.id })

    assert.equal(result.status, 200, `PUT devait réussir, got ${result.status} ${JSON.stringify(result.data)}`)
    assert.equal(result.data.first_name, 'Autosave', 'first_name préservé')
    assert.equal(result.data.last_name, 'Test', 'last_name préservé')
    assert.equal(result.data.company_id, company.id, 'company_id mis à jour')
  })

  test('PUT partiel avec first_name vide est rejeté', async () => {
    const result = await page.evaluate(async ({ tok, id }) => {
      const r = await fetch(`/erp/api/contacts/${id}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ first_name: '' }),
      })
      return { status: r.status, data: await r.json() }
    }, { tok: token, id: contactId })

    assert.equal(result.status, 400, 'first_name vide doit être rejeté')
  })
})
