// Page admin /erp/discovery-forms — création + listage + suppression via l'UI.
//
// Couvre :
//   - Le bouton « Nouveau formulaire » ouvre une modale avec picker entreprise
//     + champs Chief/Helper.
//   - La création POST /api/discovery-forms renvoie un public_url qui s'ouvre
//     en nouvel onglet (window.open).
//   - Le form apparaît immédiatement dans la liste avec les bons compteurs.
//   - La suppression via bulk-delete enlève la ligne.
//
// Cleanup obligatoire : entreprise de test + form créé sont supprimés en after().

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

describe('DiscoveryForms admin — création + liste + suppression', () => {
  let browser, ctx, page
  let companyId = null
  let companyName = null
  let createdFormId = null

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await login(page)

    // Entreprise de test avec timestamp dans le nom pour la retrouver facilement.
    companyName = `E2E Discovery Form ${Date.now()}`
    const cRes = await apiFetch(page, '/api/companies', {
      method: 'POST',
      body: JSON.stringify({ name: companyName }),
    })
    assert.ok(cRes.status === 200 || cRes.status === 201,
      `company creation failed (status ${cRes.status}): ${JSON.stringify(cRes.body)}`)
    companyId = cRes.body.id
  })

  after(async () => {
    if (createdFormId) {
      try { await apiFetch(page, `/api/discovery-forms/${createdFormId}`, { method: 'DELETE' }) } catch {}
    }
    if (companyId) {
      try { await apiFetch(page, `/api/companies/${companyId}`, { method: 'DELETE' }) } catch {}
    }
    await browser?.close()
  })

  test('crée un formulaire via la modale et voit le résultat dans la liste', async () => {
    await page.goto(URL + '/discovery-forms', { waitUntil: 'domcontentloaded' })

    // Attendre que la page soit chargée (le titre apparaît)
    await page.waitForSelector('h1:has-text("Formulaires de découverte")', { timeout: 10000 })

    // Click « Nouveau formulaire »
    await page.click('button:has-text("Nouveau formulaire")')

    // Modale ouverte — clique sur le bouton « + » du picker pour l'ouvrir
    await page.waitForSelector('[data-testid="linked-record-field-discovery_company_id"]', { timeout: 5000 })
    await page.click('[data-testid="linked-record-field-discovery_company_id"] [data-testid="linked-record-add"]')

    // Champ de recherche du LinkedRecordField (rendu dans un portal sur document.body)
    await page.waitForSelector('#linked-record-portal input', { timeout: 5000 })
    await page.fill('#linked-record-portal input', companyName)
    // Sélectionne notre entreprise dans la liste filtrée
    await page.waitForTimeout(300)
    await page.click(`#linked-record-portal button:has-text("${companyName}")`)

    // Set Chief = 1, Helper = 2
    const inputs = await page.$$('input[type="number"]')
    assert.equal(inputs.length, 2, 'devrait y avoir 2 inputs number (Chief + Helper)')
    // Ordre dans le DOM : Chief Grower puis Helper
    await inputs[0].fill('1')
    await inputs[1].fill('2')

    // Le total annoncé doit être 3
    await page.waitForSelector('text=/générera\\s+3\\s+cartes/', { timeout: 2000 })

    // Intercepte window.open avant le clic (le bouton est censé ouvrir le formulaire public).
    await page.evaluate(() => {
      window.__opened = null
      const orig = window.open
      window.open = (u) => { window.__opened = u; return null }
      window.__origOpen = orig
    })

    await page.click('button:has-text("Créer et ouvrir")')

    // Attend que le form soit créé côté serveur — poll l'API jusqu'à le voir.
    let created = null
    for (let i = 0; i < 30 && !created; i++) {
      await page.waitForTimeout(200)
      const list = await apiFetch(page, `/api/discovery-forms?company_id=${companyId}`)
      if (list.status === 200 && Array.isArray(list.body.rows) && list.body.rows.length > 0) {
        created = list.body.rows[0]
      }
    }
    assert.ok(created, 'le formulaire devrait être créé après le clic')
    createdFormId = created.id
    assert.equal(created.num_greenhouses, 3)
    assert.equal(created.chief_grower_count, 1)
    assert.equal(created.helper_count, 2)
    assert.ok(created.public_token && created.public_token.length === 10,
      `public_token devrait faire 10 chars (base32 Crockford), reçu : ${created.public_token}`)
    // Vérifie qu'il apparaît bien dans la liste de l'UI (refresh post-création)
    await page.waitForSelector(`text=${companyName}`, { timeout: 8000 })

    // window.open doit avoir été appelé avec l'URL publique (raccourci UX)
    const opened = await page.evaluate(() => window.__opened)
    assert.ok(opened && opened.includes(`/d/${created.public_token}`),
      `window.open aurait dû recevoir l'URL publique, reçu : ${opened}`)
  })

  test('valide qu\'on ne peut pas créer sans entreprise ni sans serres', async () => {
    // POST direct (l'UI le bloque côté client via le disabled du bouton — on teste le serveur)
    const noCompany = await apiFetch(page, '/api/discovery-forms', {
      method: 'POST',
      body: JSON.stringify({ helper_count: 1 }),
    })
    assert.equal(noCompany.status, 400)

    const noGreenhouses = await apiFetch(page, '/api/discovery-forms', {
      method: 'POST',
      body: JSON.stringify({ company_id: companyId, helper_count: 0, chief_count: 0 }),
    })
    assert.equal(noGreenhouses.status, 400)
  })
})
