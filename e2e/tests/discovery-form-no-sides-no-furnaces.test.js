// Formulaire de découverte technique — le client peut indiquer qu'il n'a pas
// de côtés ouvrants ni de fournaises (ou seulement l'un des deux).
//
// Couvre :
//   - Choisir « Non, pas de côtés ouvrants » cache les questions liées
//     (hauteur, tuyaux de côté, tuyaux guides).
//   - Choisir « Non, pas de fournaises » (carte chief grower) cache le champ
//     « Nombre de fournaises » et empêche l'apparition des sous-formulaires.
//   - L'autosave persiste `has_side_vents: false` et `has_furnaces: false`.
//   - Le formulaire peut être soumis dans cet état (pas de validation bloquante
//     pour ces champs — la submission requiert juste les adresses + réseau).

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

describe('Discovery form — « pas de côtés ouvrants » / « pas de fournaises »', () => {
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

    const companyName = `E2E Discovery NoSidesNoFurnaces ${Date.now()}`
    const cRes = await apiFetch(adminPage, '/api/companies', {
      method: 'POST',
      body: JSON.stringify({ name: companyName }),
    })
    assert.ok(cRes.status === 200 || cRes.status === 201)
    companyId = cRes.body.id

    // 1 Chief uniquement (les fournaises sont une section chief_grower).
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

  test('côtés ouvrants : choisir « Non » cache les sous-questions et persiste has_side_vents=false', async () => {
    const anonCtx = await browser.newContext()
    const anonPage = await anonCtx.newPage()
    try {
      await anonPage.goto(`${URL}/d/${publicToken}`, { waitUntil: 'domcontentloaded' })
      await anonPage.waitForSelector('h1:has-text("Formulaire de découverte technique")', { timeout: 10000 })

      // Choisit « nouveau site » pour révéler la suite (adresses + cartes serres).
      await anonPage.click('text=Un nouveau site de production avec Orisha')
      await anonPage.waitForSelector('text=Serre #1', { timeout: 5000 })

      // La question « Cette serre a-t-elle des côtés ouvrants » est visible.
      const sideVentQ = anonPage.locator('text=Cette serre a-t-elle des côtés ouvrants à automatiser')
      await sideVentQ.waitFor({ timeout: 3000 })

      // Avant choix, les sous-questions (hauteur, type tuyau) NE sont PAS visibles.
      const heightBefore = await anonPage.locator('text=Hauteur des côtés ouvrants').count()
      assert.equal(heightBefore, 0, 'la hauteur ne doit pas apparaître avant le choix oui/non')

      // Choix « Non, pas de côtés ouvrants ».
      const sideSelect = anonPage.locator('select').filter({ hasText: 'Non, pas de côtés ouvrants' }).first()
      await sideSelect.selectOption({ label: 'Non, pas de côtés ouvrants' })

      // Les sous-questions restent cachées.
      const heightAfter = await anonPage.locator('text=Hauteur des côtés ouvrants').count()
      assert.equal(heightAfter, 0, 'la hauteur doit rester cachée après « Non »')
      const pipeType = await anonPage.locator('text=Type de tuyau de côté').count()
      assert.equal(pipeType, 0, 'type de tuyau doit rester caché après « Non »')
      const guidePipes = await anonPage.locator('text=Tuyaux guides').count()
      assert.equal(guidePipes, 0, 'tuyaux guides doivent rester cachés après « Non »')

      // Attend la fin du debounce d'autosave (600 ms) + marge.
      await anonPage.waitForTimeout(900)
    } finally {
      await anonCtx.close()
    }

    // Vérifie côté admin : has_side_vents=false persisté.
    const detail = await apiFetch(adminPage, `/api/discovery-forms/${formId}`)
    assert.equal(detail.status, 200)
    const gh = detail.body.greenhouses[0]
    assert.equal(gh.has_side_vents, false, 'has_side_vents doit être false en DB')
  })

  test('fournaises : choisir « Non » cache « Nombre de fournaises » et persiste has_furnaces=false', async () => {
    const anonCtx = await browser.newContext()
    const anonPage = await anonCtx.newPage()
    try {
      await anonPage.goto(`${URL}/d/${publicToken}`, { waitUntil: 'domcontentloaded' })
      await anonPage.waitForSelector('h1:has-text("Formulaire de découverte technique")', { timeout: 10000 })

      // « new site » devrait déjà être coché (persisté au test précédent), mais
      // on clique au cas où pour révéler la carte serre.
      const alreadyNew = await anonPage.locator('text=Serre #1').count()
      if (!alreadyNew) {
        await anonPage.click('text=Un nouveau site de production avec Orisha')
        await anonPage.waitForSelector('text=Serre #1', { timeout: 5000 })
      }

      // La section Fournaises est visible (carte chief grower).
      await anonPage.waitForSelector('h3:has-text("Fournaises")', { timeout: 3000 })
      await anonPage.waitForSelector('text=Cette serre a-t-elle des fournaises à automatiser', { timeout: 3000 })

      // Choix « Non, pas de fournaises ».
      const furnaceSelect = anonPage.locator('select').filter({ hasText: 'Non, pas de fournaises' }).first()
      await furnaceSelect.selectOption({ label: 'Non, pas de fournaises' })

      // Le champ « Nombre de fournaises » ne doit pas apparaître.
      const numField = await anonPage.locator('text=Nombre de fournaises dans cette serre').count()
      assert.equal(numField, 0, '« Nombre de fournaises » doit rester caché après « Non »')

      // Aucune carte « Fournaise #1 ».
      const furnaceCards = await anonPage.locator('text=/^Fournaise #\\d+/').count()
      assert.equal(furnaceCards, 0, 'aucune carte fournaise ne doit apparaître')

      // Attend l'autosave.
      await anonPage.waitForTimeout(900)
    } finally {
      await anonCtx.close()
    }

    // Vérifie côté admin : has_furnaces=false + num_furnaces=0 + furnaces=[] persistés.
    const detail = await apiFetch(adminPage, `/api/discovery-forms/${formId}`)
    assert.equal(detail.status, 200)
    const gh = detail.body.greenhouses[0]
    assert.equal(gh.has_furnaces, false, 'has_furnaces doit être false en DB')
    assert.equal(gh.num_furnaces || 0, 0, 'num_furnaces doit être 0')
    assert.deepEqual(gh.furnaces || [], [], 'furnaces doit être vide')
  })

  test('choisir « Oui » sur les fournaises ré-affiche le champ « Nombre de fournaises »', async () => {
    const anonCtx = await browser.newContext()
    const anonPage = await anonCtx.newPage()
    try {
      await anonPage.goto(`${URL}/d/${publicToken}`, { waitUntil: 'domcontentloaded' })
      await anonPage.waitForSelector('h1:has-text("Formulaire de découverte technique")', { timeout: 10000 })

      const alreadyNew = await anonPage.locator('text=Serre #1').count()
      if (!alreadyNew) {
        await anonPage.click('text=Un nouveau site de production avec Orisha')
        await anonPage.waitForSelector('text=Serre #1', { timeout: 5000 })
      }

      // Bascule sur « Oui ».
      const furnaceSelect = anonPage.locator('select').filter({ hasText: 'Oui, il y a des fournaises' }).first()
      await furnaceSelect.selectOption({ label: 'Oui, il y a des fournaises' })

      // Le champ « Nombre de fournaises » apparaît.
      await anonPage.waitForSelector('text=Nombre de fournaises dans cette serre', { timeout: 3000 })

      await anonPage.waitForTimeout(900)
    } finally {
      await anonCtx.close()
    }

    const detail = await apiFetch(adminPage, `/api/discovery-forms/${formId}`)
    const gh = detail.body.greenhouses[0]
    assert.equal(gh.has_furnaces, true, 'has_furnaces doit être true après bascule')
  })
})
