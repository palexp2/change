// Formulaire de découverte technique — accès public via /erp/d/:token (sans auth).
//
// Couvre :
//   - GET /api/customer/post-payment/by-token/:token retourne 200 sans auth.
//   - La page React /erp/d/:token affiche le wizard avec le bon nombre de cartes
//     pré-créées (1 par Helper + 1 par Chief), sans le champ « Combien de serres ».
//   - L'autosave POST by-token/:token/save fonctionne (un patch est persisté).
//   - Le token est tolérant aux confusions Crockford (O→0, I/L→1, U→V).
//
// Ce test exécute le setup côté admin (création form via API authentifiée), puis
// ouvre la page publique dans un NOUVEAU context (sans cookies/localStorage) pour
// vraiment vérifier qu'aucune auth n'est requise.

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

describe('Formulaire de découverte — accès public /erp/d/:token', () => {
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

    const companyName = `E2E Discovery Public ${Date.now()}`
    const cRes = await apiFetch(adminPage, '/api/companies', {
      method: 'POST',
      body: JSON.stringify({ name: companyName }),
    })
    assert.ok(cRes.status === 200 || cRes.status === 201)
    companyId = cRes.body.id

    // 1 Chief + 2 Helpers → 3 cartes
    const fRes = await apiFetch(adminPage, '/api/discovery-forms', {
      method: 'POST',
      body: JSON.stringify({ company_id: companyId, chief_count: 1, helper_count: 2 }),
    })
    assert.equal(fRes.status, 201, `form creation failed: ${JSON.stringify(fRes.body)}`)
    formId = fRes.body.id
    publicToken = fRes.body.public_token
    assert.ok(publicToken && publicToken.length === 10)
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

  test('GET by-token retourne 200 sans aucune auth (autre context, pas de token)', async () => {
    const anonCtx = await browser.newContext()
    const anonPage = await anonCtx.newPage()
    try {
      // Navigation préalable pour que les URLs relatives marchent dans evaluate().
      await anonPage.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
      const res = await anonPage.evaluate(async (token) => {
        const r = await fetch('/erp/api/customer/post-payment/by-token/' + encodeURIComponent(token))
        return { status: r.status, body: await r.json() }
      }, publicToken)
      assert.equal(res.status, 200, `attendu 200, reçu ${res.status}`)
      assert.equal(res.body.source, 'qualification')
      assert.equal(res.body.greenhouse_count_locked, true)
      assert.equal(res.body.detected.has_chief_grower, true)
      assert.equal(res.body.detected.has_helper, true)
      assert.equal(res.body.response.greenhouses.length, 3)
      assert.equal(res.body.response.greenhouses[0].permission_level, 'chief_grower')
      assert.equal(res.body.response.greenhouses[1].permission_level, 'helper')
      assert.equal(res.body.response.greenhouses[2].permission_level, 'helper')
    } finally {
      await anonCtx.close()
    }
  })

  test('token tolérant aux confusions Crockford (minuscules + tirets)', async () => {
    const anonCtx = await browser.newContext()
    const anonPage = await anonCtx.newPage()
    try {
      await anonPage.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
      // Reformate le token en minuscules avec tirets — le serveur doit normaliser
      const garbled = publicToken.toLowerCase().match(/.{1,4}/g).join('-')
      const res = await anonPage.evaluate(async (t) => {
        const r = await fetch('/erp/api/customer/post-payment/by-token/' + encodeURIComponent(t))
        return { status: r.status }
      }, garbled)
      assert.equal(res.status, 200, `token reformaté devrait être accepté, reçu ${res.status}`)
    } finally {
      await anonCtx.close()
    }
  })

  test('la page /erp/d/:token affiche le wizard sans champ "Combien de serres"', async () => {
    const anonCtx = await browser.newContext()
    const anonPage = await anonCtx.newPage()
    try {
      await anonPage.goto(`${URL}/d/${publicToken}`, { waitUntil: 'domcontentloaded' })
      // Attend le titre du formulaire de découverte
      await anonPage.waitForSelector('h1:has-text("Formulaire de découverte technique")', { timeout: 10000 })
      // Le step « Type de commande » est toujours visible (première question)
      await anonPage.waitForSelector('text=Type de commande', { timeout: 3000 })
      // Choisit « nouveau site » pour révéler les sections suivantes
      await anonPage.click('text=Un nouveau site de production avec Orisha')
      // Attend que les cartes serres apparaissent (3 cartes pré-créées)
      await anonPage.waitForSelector('text=Serre #1', { timeout: 5000 })
      const cards = await anonPage.locator('text=/^Serre #\\d+/').count()
      assert.equal(cards, 3, `attendu 3 cartes serres, vu ${cards}`)
      // Le champ « Combien de serres » NE doit PAS apparaître (greenhouse_count_locked=true)
      const lockedField = await anonPage.locator('text=Combien de serres voulez-vous automatiser').count()
      assert.equal(lockedField, 0, 'le champ "Combien de serres" devrait être caché en mode by-token')
      // La première carte est étiquetée « Chief », les 2 suivantes « Helper »
      await anonPage.waitForSelector('text=Serre #1 (Chief)', { timeout: 2000 })
      await anonPage.waitForSelector('text=Serre #2 (Helper)', { timeout: 2000 })
    } finally {
      await anonCtx.close()
    }
  })

  test('autosave via POST by-token/save persiste un patch', async () => {
    const anonCtx = await browser.newContext()
    const anonPage = await anonCtx.newPage()
    try {
      await anonPage.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
      const saveRes = await anonPage.evaluate(async (token) => {
        const r = await fetch(`/erp/api/customer/post-payment/by-token/${encodeURIComponent(token)}/save`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ is_new_site: 'new', network_access: 'ethernet' }),
        })
        return { status: r.status, body: await r.json() }
      }, publicToken)
      assert.equal(saveRes.status, 200)
      assert.equal(saveRes.body.response.is_new_site, 'new')
      assert.equal(saveRes.body.response.network_access, 'ethernet')
    } finally {
      await anonCtx.close()
    }

    // Vérifie côté admin que la persistence a bien eu lieu
    const detail = await apiFetch(adminPage, `/api/discovery-forms/${formId}`)
    assert.equal(detail.status, 200)
    assert.equal(detail.body.is_new_site, 'new')
  })
})
