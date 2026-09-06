// Le <select> natif « Province » de l'AddressForm (page publique post-paiement
// /erp/d/:token) a été remplacé par le composant SearchableSelect — règle CLAUDE.md
// « dropdowns avec recherche » pour toute liste > 10 options (13 provinces/territoires).
//
// Ce test vérifie sur la VRAIE page publique (context anonyme, sans auth) que :
//   - le déclencheur du select rend hors du shell ERP (page publique) ;
//   - cliquer ouvre un menu en portail avec une zone de recherche ;
//   - la recherche filtre les options (« québec » → une seule, QC) ;
//   - sélectionner une option persiste le code province via l'autosave by-token.
//
// Setup admin (création company + discovery form) puis ouverture anonyme, comme
// discovery-form-public-by-token.test.js. Cleanup complet en after().

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

describe('Province SearchableSelect — page publique /erp/d/:token', () => {
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

    const cRes = await apiFetch(adminPage, '/api/companies', {
      method: 'POST',
      body: JSON.stringify({ name: `E2E Province Search ${Date.now()}` }),
    })
    assert.ok(cRes.status === 200 || cRes.status === 201)
    companyId = cRes.body.id

    const fRes = await apiFetch(adminPage, '/api/discovery-forms', {
      method: 'POST',
      body: JSON.stringify({ company_id: companyId, chief_count: 1, helper_count: 1 }),
    })
    assert.equal(fRes.status, 201, `form creation failed: ${JSON.stringify(fRes.body)}`)
    formId = fRes.body.id
    publicToken = fRes.body.public_token
    assert.ok(publicToken && publicToken.length === 10)
  })

  after(async () => {
    // Record créé par le test (form + company) → suppression complète, pas de
    // config existante écrasée ici.
    if (formId) {
      try { await apiFetch(adminPage, `/api/discovery-forms/${formId}`, { method: 'DELETE' }) } catch {}
    }
    if (companyId) {
      try { await apiFetch(adminPage, `/api/companies/${companyId}`, { method: 'DELETE' }) } catch {}
    }
    await browser?.close()
  })

  test('recherche + sélection de la province, rendu hors shell ERP, persistance autosave', async () => {
    const anonCtx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    const anonPage = await anonCtx.newPage()
    try {
      await anonPage.goto(`${URL}/d/${publicToken}`, { waitUntil: 'domcontentloaded' })
      await anonPage.waitForSelector('h1:has-text("Formulaire de découverte technique")', { timeout: 10000 })

      // Révèle la carte « Adresse de la ferme » (qui contient le 1er AddressForm).
      await anonPage.click('text=Un nouveau site de production avec Orisha')
      await anonPage.waitForSelector('h2:has-text("Adresse de la ferme")', { timeout: 5000 })

      // Scope sur la carte ferme (1er des deux AddressForm).
      const farmCard = anonPage.locator('div.bg-white', { has: anonPage.locator('h2:has-text("Adresse de la ferme")') }).first()
      const trigger = farmCard.locator('[data-testid="province-select"]')
      await trigger.waitFor({ timeout: 3000 })

      // Le déclencheur affiche le placeholder « — » au départ.
      assert.match((await trigger.innerText()).trim(), /—/, 'placeholder attendu au départ')

      // Ouvre le menu en portail (rendu sur document.body, donc fonctionne hors shell ERP).
      await trigger.click()
      const menu = anonPage.locator('[data-testid="province-select-menu"]')
      await menu.waitFor({ timeout: 3000 })
      const searchInput = menu.locator('input[placeholder="Rechercher une province…"]')
      await searchInput.waitFor({ timeout: 2000 })

      // Toutes les options présentes (13 provinces/territoires + entrée vide « — »).
      const allOptions = await menu.locator('button').count()
      assert.ok(allOptions >= 13, `attendu ≥13 options, vu ${allOptions}`)

      // La recherche « québec » filtre vers une seule province.
      await searchInput.fill('québec')
      await anonPage.waitForTimeout(150)
      const qcOption = menu.locator('button:has-text("Québec")')
      assert.equal(await qcOption.count(), 1, 'la recherche « québec » devrait ne laisser que QC')
      // Une autre province (Alberta) ne doit plus apparaître.
      assert.equal(await menu.locator('button:has-text("Alberta")').count(), 0, 'Alberta ne devrait pas matcher « québec »')

      // Sélectionne QC.
      await qcOption.click()
      await menu.waitFor({ state: 'detached', timeout: 3000 })

      // Le déclencheur reflète la sélection (label complet).
      assert.match((await trigger.innerText()).trim(), /QC — Québec/, 'le déclencheur devrait montrer QC — Québec')

      // L'autosave a persisté le code « QC » (pas le label) dans farm_address.province.
      // On laisse le debounce d'autosave (~500ms) s'écouler puis on relit via by-token.
      await anonPage.waitForTimeout(1500)
      const reread = await anonPage.evaluate(async (token) => {
        const r = await fetch('/erp/api/customer/post-payment/by-token/' + encodeURIComponent(token))
        return { status: r.status, body: await r.json() }
      }, publicToken)
      assert.equal(reread.status, 200)
      assert.equal(reread.body.response.farm_address?.province, 'QC', 'le code province « QC » devrait être persisté')
    } finally {
      await anonCtx.close()
    }
  })
})
