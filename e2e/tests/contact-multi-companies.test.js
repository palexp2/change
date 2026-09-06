const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie qu'un contact peut être lié à plusieurs entreprises via la jointure
// contact_companies : ajout, bascule de la principale, suppression. Vérifie
// aussi que `contacts.company_id` reste synchronisé avec la principale.
describe('Contacts — multi-entreprises (jointure contact_companies)', () => {
  let browser, ctx, page, token, contactId, companyAId, companyBId

  async function api(method, path, body) {
    return await page.evaluate(async ({ tok, method, path, body }) => {
      const r = await fetch(`/erp/api${path}`, {
        method,
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      })
      let data = null
      try { data = await r.json() } catch {}
      return { status: r.status, data }
    }, { tok: token, method, path, body })
  }

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

    const stamp = Date.now()
    const a = await api('POST', '/companies', { name: `E2E Multi A ${stamp}` })
    assert.equal(a.status, 201, `create company A: ${JSON.stringify(a.data)}`)
    companyAId = a.data.id
    const b = await api('POST', '/companies', { name: `E2E Multi B ${stamp}` })
    assert.equal(b.status, 201, `create company B: ${JSON.stringify(b.data)}`)
    companyBId = b.data.id
    const c = await api('POST', '/contacts', {
      first_name: 'E2E', last_name: `Multi ${stamp}`, email: `e2e-multi-${stamp}@test.local`,
      company_id: companyAId,
    })
    assert.equal(c.status, 201, `create contact: ${JSON.stringify(c.data)}`)
    contactId = c.data.id
  })

  after(async () => {
    if (contactId) await api('DELETE', `/contacts/${contactId}`)
    if (companyAId) await api('DELETE', `/companies/${companyAId}`)
    if (companyBId) await api('DELETE', `/companies/${companyBId}`)
    await browser?.close()
  })

  test('création du contact crée le lien principal automatiquement', async () => {
    const r = await api('GET', `/contacts/${contactId}`)
    assert.equal(r.status, 200)
    assert.equal(r.data.company_id, companyAId, 'company_id pointe sur A')
    const cs = r.data.companies
    assert.equal(cs.length, 1, 'un seul lien initialement')
    assert.equal(cs[0].company_id, companyAId)
    assert.equal(cs[0].is_primary, 1, 'A est principale')
  })

  test('ajout d\'une 2e entreprise via /companies', async () => {
    const r = await api('POST', `/contacts/${contactId}/companies`, { company_id: companyBId })
    assert.equal(r.status, 201, JSON.stringify(r.data))
    const cs = r.data.companies
    assert.equal(cs.length, 2)
    const linkA = cs.find(c => c.company_id === companyAId)
    const linkB = cs.find(c => c.company_id === companyBId)
    assert.equal(linkA.is_primary, 1, 'A reste principale')
    assert.equal(linkB.is_primary, 0, 'B est secondaire')
    assert.equal(r.data.company_id, companyAId, 'contacts.company_id reste sur A')
  })

  test('ajouter la même entreprise renvoie 409', async () => {
    const r = await api('POST', `/contacts/${contactId}/companies`, { company_id: companyBId })
    assert.equal(r.status, 409)
  })

  test('le contact apparaît dans /companies/A et /companies/B avec badge secondaire pour B', async () => {
    const a = await api('GET', `/companies/${companyAId}`)
    const b = await api('GET', `/companies/${companyBId}`)
    const inA = a.data.contacts.find(c => c.id === contactId)
    const inB = b.data.contacts.find(c => c.id === contactId)
    assert.ok(inA, 'contact présent dans entreprise A')
    assert.ok(inB, 'contact présent dans entreprise B')
    assert.equal(inA.link_is_primary, 1)
    assert.equal(inB.link_is_primary, 0)
  })

  test('basculer la principale vers B met à jour contacts.company_id', async () => {
    const after = await api('GET', `/contacts/${contactId}`)
    const linkB = after.data.companies.find(c => c.company_id === companyBId)
    const r = await api('PATCH', `/contacts/${contactId}/companies/${linkB.link_id}`, { is_primary: true })
    assert.equal(r.status, 200)
    assert.equal(r.data.company_id, companyBId, 'contacts.company_id pointe sur B')
    const cs = r.data.companies
    assert.equal(cs.find(c => c.company_id === companyBId).is_primary, 1)
    assert.equal(cs.find(c => c.company_id === companyAId).is_primary, 0)
  })

  test('retirer la principale promeut l\'autre entreprise', async () => {
    const before = await api('GET', `/contacts/${contactId}`)
    const linkB = before.data.companies.find(c => c.company_id === companyBId && c.is_primary)
    assert.ok(linkB, 'B est bien la principale')
    const r = await api('DELETE', `/contacts/${contactId}/companies/${linkB.link_id}`)
    assert.equal(r.status, 200)
    assert.equal(r.data.company_id, companyAId, 'A est promue principale')
    assert.equal(r.data.companies.length, 1)
    assert.equal(r.data.companies[0].is_primary, 1)
  })

  test('UI ContactDetail affiche les entreprises liées', async () => {
    // Remet 2 entreprises pour vérifier l'affichage
    await api('POST', `/contacts/${contactId}/companies`, { company_id: companyBId })
    await page.goto(`${URL}/contacts/${contactId}`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="contact-companies"]', { timeout: 10000 })
    const rows = page.locator('[data-testid="contact-company-row"]')
    await rows.first().waitFor({ timeout: 5000 })
    const count = await rows.count()
    assert.equal(count, 2, 'deux lignes d\'entreprise affichées')
    // La principale doit avoir le badge "Principale"
    const primaryText = await page.locator('[data-testid="contact-company-row"]', { hasText: 'Principale' }).first().textContent()
    assert.ok(primaryText.includes('Principale'))
  })
})
