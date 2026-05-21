// Realtime — la liste des contacts d'une entreprise se rafraîchit live
// quand un autre onglet/utilisateur lie ou délie un contact via les endpoints
// /contacts/:id/companies, ou modifie/crée/supprime un contact.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

async function login(page) {
  await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASS)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
}

describe('Realtime — onglet Contacts d\'une entreprise', () => {
  let browser, ctxA, ctxB, pageA, pageB
  let companyAId, companyBId, contactId, tokenB

  async function apiB(method, path, body) {
    return await pageB.evaluate(async ({ tok, method, path, body }) => {
      const r = await fetch(`/erp/api${path}`, {
        method,
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      })
      let data = null
      try { data = await r.json() } catch {}
      return { status: r.status, data }
    }, { tok: tokenB, method, path, body })
  }

  before(async () => {
    browser = await chromium.launch()
    ctxA = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    ctxB = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    pageA = await ctxA.newPage()
    pageB = await ctxB.newPage()
    await login(pageA)
    await login(pageB)
    tokenB = await pageB.evaluate(() => localStorage.getItem('erp_token'))

    const stamp = Date.now()
    const a = await apiB('POST', '/companies', { name: `E2E RT A ${stamp}` })
    companyAId = a.data.id
    const b = await apiB('POST', '/companies', { name: `E2E RT B ${stamp}` })
    companyBId = b.data.id
    const c = await apiB('POST', '/contacts', {
      first_name: 'E2E', last_name: `Realtime ${stamp}`, email: `e2e-rt-${stamp}@test.local`,
      company_id: companyAId,
    })
    contactId = c.data.id
  })

  after(async () => {
    if (contactId) await apiB('DELETE', `/contacts/${contactId}`)
    if (companyAId) await apiB('DELETE', `/companies/${companyAId}`)
    if (companyBId) await apiB('DELETE', `/companies/${companyBId}`)
    await browser?.close()
  })

  test('B lie le contact à l\'entreprise B → la fiche B ouverte chez A le voit apparaître', async () => {
    // A ouvre la fiche entreprise B, va à l'onglet contacts
    await pageA.goto(`${URL}/companies/${companyBId}`, { waitUntil: 'networkidle' })
    // Clique précisément sur le bouton de tab "Contacts" (texte exact).
    await pageA.getByRole('button', { name: /^Contacts/ }).click()
    // Empty state "Aucun contact" doit être visible pour confirmer que le tab est actif
    await pageA.locator('text=Aucun contact').waitFor({ state: 'visible', timeout: 5000 })
    // Petit délai pour s'assurer que le WS est abonné au canal company:${companyBId}.
    await pageA.waitForTimeout(1000)

    // B lie le contact à companyB
    const r = await apiB('POST', `/contacts/${contactId}/companies`, { company_id: companyBId })
    assert.equal(r.status, 201, JSON.stringify(r.data))

    // A doit voir apparaître la ligne sans recharger
    const row = pageA.locator(`tr:has-text("E2E Realtime")`).first()
    await row.waitFor({ state: 'visible', timeout: 8000 })
  })

  test('B délie le contact de B → la ligne disparaît live chez A', async () => {
    // Récupère le linkId
    const r = await apiB('GET', `/contacts/${contactId}`)
    const linkB = r.data.companies.find(c => c.company_id === companyBId)
    assert.ok(linkB, 'le lien à B devrait exister')

    await apiB('DELETE', `/contacts/${contactId}/companies/${linkB.link_id}`)

    // La ligne doit disparaître chez A
    const row = pageA.locator(`tr:has-text("E2E Realtime")`).first()
    await row.waitFor({ state: 'detached', timeout: 3000 })
  })
})
