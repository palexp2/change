// Formulaire de découverte technique — flow paiement des blocs de 4 valves
// supplémentaires quand une serre dépasse 4 zones d'irrigation.
//
// Couvre :
//   - GET /by-token/:token retourne `valve_blocks_needed` calculé depuis
//     greenhouses_json (1 bloc par tranche de 4 zones au-delà de 4).
//   - POST /submit refuse avec code `valve_blocks_unpaid` si blocs requis non
//     payés. Message d'erreur clair pour le client.
//   - POST /submit accepte une fois ramené à ≤ 4 zones (sans paiement).
//   - Le frontend affiche le warning, la section paiement, et désactive le
//     bouton « Soumettre » tant que les blocs ne sont pas payés (ou les zones
//     baissées).

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

describe('Discovery form — paiement blocs de valves (zones > 4)', () => {
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

    const companyName = `E2E Discovery ValveBlocks ${Date.now()}`
    const cRes = await apiFetch(adminPage, '/api/companies', {
      method: 'POST',
      body: JSON.stringify({ name: companyName }),
    })
    assert.ok(cRes.status === 200 || cRes.status === 201)
    companyId = cRes.body.id

    // 1 Chief (la section irrigation/valves est chief grower only).
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

  // ───── API-level tests (rapides, sans navigateur) ─────

  test('GET /by-token retourne valve_blocks_needed = 0 si toutes les serres ont ≤ 4 zones', async () => {
    const anonCtx = await browser.newContext()
    const anonPage = await anonCtx.newPage()
    try {
      await anonPage.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
      // Save 4 zones (= seuil sans frais).
      await anonPage.evaluate(async (token) => {
        await fetch(`/erp/api/customer/post-payment/by-token/${encodeURIComponent(token)}/save`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ greenhouses: [{ permission_level: 'chief_grower', irrigation_zones: 4 }] }),
        })
      }, publicToken)
      const res = await anonPage.evaluate(async (token) => {
        const r = await fetch('/erp/api/customer/post-payment/by-token/' + encodeURIComponent(token))
        return { status: r.status, body: await r.json() }
      }, publicToken)
      assert.equal(res.status, 200)
      assert.equal(res.body.response.valve_blocks_needed, 0)
      assert.equal(res.body.response.valve_blocks_paid, false)
    } finally {
      await anonCtx.close()
    }
  })

  test('GET /by-token retourne valve_blocks_needed = 2 pour 12 zones (= ceil((12-4)/4))', async () => {
    const anonCtx = await browser.newContext()
    const anonPage = await anonCtx.newPage()
    try {
      await anonPage.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
      await anonPage.evaluate(async (token) => {
        await fetch(`/erp/api/customer/post-payment/by-token/${encodeURIComponent(token)}/save`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ greenhouses: [{ permission_level: 'chief_grower', irrigation_zones: 12 }] }),
        })
      }, publicToken)
      const res = await anonPage.evaluate(async (token) => {
        const r = await fetch('/erp/api/customer/post-payment/by-token/' + encodeURIComponent(token))
        return { status: r.status, body: await r.json() }
      }, publicToken)
      assert.equal(res.body.response.valve_blocks_needed, 2)
    } finally {
      await anonCtx.close()
    }
  })

  test('POST /submit refuse avec code valve_blocks_unpaid si blocs requis et non payés', async () => {
    // Pré-saisir adresses + réseau pour que les autres champs ne bloquent pas.
    const anonCtx = await browser.newContext()
    const anonPage = await anonCtx.newPage()
    try {
      await anonPage.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
      await anonPage.evaluate(async (token) => {
        await fetch(`/erp/api/customer/post-payment/by-token/${encodeURIComponent(token)}/save`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            is_new_site: 'new',
            farm_address: { line1: '1 rang Test', city: 'Test', province: 'QC', postal_code: 'A1A 1A1', country: 'Canada' },
            shipping_same_as_farm: true,
            network_access: 'ethernet',
            greenhouses: [{ permission_level: 'chief_grower', irrigation_zones: 8 }],
            num_greenhouses: 1,
          }),
        })
      }, publicToken)
      const sub = await anonPage.evaluate(async (token) => {
        const r = await fetch(`/erp/api/customer/post-payment/by-token/${encodeURIComponent(token)}/submit`, { method: 'POST' })
        return { status: r.status, body: await r.json() }
      }, publicToken)
      assert.equal(sub.status, 400)
      assert.equal(sub.body.code, 'valve_blocks_unpaid')
      assert.equal(sub.body.valve_blocks_needed, 1)
      assert.match(sub.body.error, /baissez à 4 zones|payer plus bas/i)
    } finally {
      await anonCtx.close()
    }
  })

  test('POST /submit accepte si on baisse les zones à 4 (sans paiement)', async () => {
    const anonCtx = await browser.newContext()
    const anonPage = await anonCtx.newPage()
    try {
      await anonPage.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
      await anonPage.evaluate(async (token) => {
        await fetch(`/erp/api/customer/post-payment/by-token/${encodeURIComponent(token)}/save`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            greenhouses: [{ permission_level: 'chief_grower', irrigation_zones: 4 }],
          }),
        })
      }, publicToken)
      const sub = await anonPage.evaluate(async (token) => {
        const r = await fetch(`/erp/api/customer/post-payment/by-token/${encodeURIComponent(token)}/submit`, { method: 'POST' })
        return { status: r.status, body: await r.json() }
      }, publicToken)
      assert.equal(sub.status, 200, `expected 200, got ${sub.status}: ${JSON.stringify(sub.body)}`)
      assert.equal(sub.body.response.status, 'submitted')
    } finally {
      await anonCtx.close()
    }
  })

  // ───── UI-level test (warning + bouton bloqué) ─────

  test('UI : warning visible + section paiement + bouton Soumettre désactivé quand zones > 4', async () => {
    // Recréer un autre form (le précédent est en status=submitted).
    const fRes = await apiFetch(adminPage, '/api/discovery-forms', {
      method: 'POST',
      body: JSON.stringify({ company_id: companyId, chief_count: 1, helper_count: 0 }),
    })
    assert.equal(fRes.status, 201)
    const altFormId = fRes.body.id
    const altToken = fRes.body.public_token

    const anonCtx = await browser.newContext()
    const anonPage = await anonCtx.newPage()
    try {
      // Pré-saisie via API pour aller direct à l'étape qui m'intéresse.
      await anonPage.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
      await anonPage.evaluate(async (token) => {
        await fetch(`/erp/api/customer/post-payment/by-token/${encodeURIComponent(token)}/save`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            is_new_site: 'new',
            farm_address: { line1: '1 rang Test', city: 'Test', province: 'QC', postal_code: 'A1A 1A1', country: 'Canada' },
            shipping_same_as_farm: true,
            network_access: 'ethernet',
            greenhouses: [{ permission_level: 'chief_grower', irrigation_zones: 8 }],
            num_greenhouses: 1,
          }),
        })
      }, altToken)

      await anonPage.goto(`${URL}/d/${altToken}`, { waitUntil: 'domcontentloaded' })
      await anonPage.waitForSelector('h1:has-text("Formulaire de découverte technique")', { timeout: 10000 })

      // Le warning doit apparaître (8 zones > 4, donc 1 bloc requis).
      await anonPage.waitForSelector('text=Payer plus bas dans le formulaire', { timeout: 5000 })
      await anonPage.waitForSelector('text=Aviser votre conseiller @orisha', { timeout: 2000 })

      // La section paiement (Card) doit apparaître plus bas.
      await anonPage.waitForSelector('h2:has-text("Blocs de valves supplémentaires")', { timeout: 5000 })
      await anonPage.waitForSelector('button:has-text("Payer 400 $ par Stripe")', { timeout: 2000 })
      // Mention de l'option mensuelle = contact conseiller.
      await anonPage.waitForSelector('text=contactez votre conseiller @orisha', { timeout: 2000 })

      // Le bouton « Soumettre » doit être désactivé.
      const submitBtn = anonPage.locator('button:has-text("Soumettre")')
      await submitBtn.waitFor({ timeout: 2000 })
      const disabled = await submitBtn.isDisabled()
      assert.equal(disabled, true, 'le bouton Soumettre doit être désactivé tant que blocs non payés')
    } finally {
      await anonCtx.close()
      // Cleanup le form additionnel
      try { await apiFetch(adminPage, `/api/discovery-forms/${altFormId}`, { method: 'DELETE' }) } catch {}
    }
  })
})
