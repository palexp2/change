// Formulaire de découverte technique — restriction du nombre de fournaises à 2.
//
// Le champ « Nombre de fournaises dans cette serre » (section Chief) doit :
//   - avoir l'attribut HTML max=2
//   - clamper la valeur saisie (ex. 5 → 2) lors du onChange

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

async function login(page) {
  await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASS)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
}

async function apiFetch(page, path, init = {}) {
  return await page.evaluate(async ({ path, init }) => {
    const tok = localStorage.getItem('erp_token')
    const headers = Object.assign({}, init.headers || {}, { Authorization: `Bearer ${tok}` })
    if (init.body) headers['Content-Type'] = 'application/json'
    const r = await fetch('/erp' + path, { ...init, headers })
    const text = await r.text()
    try { return { status: r.status, body: JSON.parse(text) } } catch { return { status: r.status, body: text } }
  }, { path, init })
}

describe('Formulaire de découverte — restriction fournaises (max 2)', () => {
  let browser
  let adminCtx, adminPage
  let companyId = null
  let formId = null
  let publicToken = null

  before(async () => {
    browser = await chromium.launch()
    adminCtx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    adminPage = await adminCtx.newPage()
    await login(adminPage)

    const companyName = `E2E Discovery Furnace ${Date.now()}`
    const cRes = await apiFetch(adminPage, '/api/companies', {
      method: 'POST',
      body: JSON.stringify({ name: companyName }),
    })
    assert.ok(cRes.status === 200 || cRes.status === 201)
    companyId = cRes.body.id

    // 1 Chief (le Chief montre la section Fournaises)
    const fRes = await apiFetch(adminPage, '/api/discovery-forms', {
      method: 'POST',
      body: JSON.stringify({ company_id: companyId, chief_count: 1, helper_count: 0 }),
    })
    assert.equal(fRes.status, 201, `form creation failed: ${JSON.stringify(fRes.body)}`)
    formId = fRes.body.id
    publicToken = fRes.body.public_token
  })

  after(async () => {
    if (formId) {
      try { await apiFetch(adminPage, `/api/discovery-forms/${formId}`, { method: 'DELETE' }) } catch {}
    }
    if (companyId) {
      try { await apiFetch(adminPage, `/api/companies/${companyId}`, { method: 'DELETE' }) } catch {}
    }
    await browser?.close()
  })

  test('input fournaises : max=2 et valeur clampée à 2 si on saisit 5', async () => {
    const anonCtx = await browser.newContext()
    const anonPage = await anonCtx.newPage()
    try {
      await anonPage.goto(`${URL}/d/${publicToken}`, { waitUntil: 'domcontentloaded' })
      await anonPage.waitForSelector('h1:has-text("Formulaire de découverte technique")', { timeout: 10000 })
      // Révèle les sections suivantes
      await anonPage.click('text=Un nouveau site de production avec Orisha')
      await anonPage.waitForSelector('text=Serre #1 (Chief)', { timeout: 5000 })

      // Localise l'input fournaises (label + input sont siblings dans Field)
      const furnacesInput = anonPage.locator('div:has(> label:text-is("Nombre de fournaises dans cette serre")) > input[type="number"]').first()
      await furnacesInput.waitFor({ timeout: 5000 })

      // Vérifie l'attribut HTML max
      const maxAttr = await furnacesInput.getAttribute('max')
      assert.equal(maxAttr, '2', `attendu max=2, reçu ${maxAttr}`)

      // Saisit 5 — doit être clampé à 2 par le handler React
      await furnacesInput.fill('5')
      await furnacesInput.blur()
      // Laisse le rerender React appliquer le clamp
      await anonPage.waitForTimeout(500)
      const valueAfter = await furnacesInput.inputValue()
      assert.equal(valueAfter, '2', `attendu valeur clampée à 2, reçu ${valueAfter}`)
    } finally {
      await anonCtx.close()
    }
  })
})
