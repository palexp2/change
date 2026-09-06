// Conformité règle CLAUDE.md « champs référence (FK) » : les champs liés
// doivent s'afficher comme liens cliquables vers la fiche cible.
//
// - SoumissionDetail : le « Projet » doit linker vers /projects/:id
// - RetourDetail     : le produit d'un article doit linker vers /products/:id
//
// Test purement en lecture (aucun record créé/modifié) → pas de cleanup ni de
// restauration nécessaires. On résout dynamiquement une soumission avec
// project_id et un retour dont un item a un product_id via l'API.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const API = URL.replace(/\/erp\/?$/, '') + '/api'
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

async function apiToken() {
  const r = await fetch(API + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASS }),
  })
  return (await r.json()).token
}

describe('Détail — champs FK projet/produit cliquables', () => {
  let browser, page, token
  let soumissionId, projectId, retourId, productId

  before(async () => {
    token = await apiToken()
    const auth = { headers: { Authorization: 'Bearer ' + token } }

    // Soumission avec project_id
    const sList = await (await fetch(API + '/projets/soumissions?limit=all', auth)).json()
    const sItems = sList.items || sList.data || sList
    const s = sItems.find(x => x.project_id)
    assert.ok(s, 'aucune soumission avec project_id trouvée')
    soumissionId = s.id
    projectId = s.project_id

    // Retour dont un item a un product_id
    const rList = await (await fetch(API + '/projets/retours?limit=all', auth)).json()
    const rItems = rList.items || rList.data || rList
    for (const ret of rItems.slice(0, 80)) {
      const d = await (await fetch(API + '/projets/retours/' + ret.id, auth)).json()
      const it = (d.items || []).find(x => x.product_id)
      if (it) { retourId = ret.id; productId = it.product_id; break }
    }
    assert.ok(retourId, 'aucun retour avec item product_id trouvé')

    browser = await chromium.launch()
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await login(page)
  })

  after(async () => {
    if (browser) await browser.close()
  })

  test('SoumissionDetail : le projet est un lien vers /projects/:id', async () => {
    await page.goto(`${URL}/soumissions/${soumissionId}`, { waitUntil: 'domcontentloaded' })
    const link = page.locator(`a[href$="/projects/${projectId}"]`)
    await link.first().waitFor({ state: 'visible', timeout: 10000 })
    await link.first().click()
    await page.waitForURL(u => u.toString().includes(`/projects/${projectId}`), { timeout: 10000 })
    assert.ok(page.url().includes(`/projects/${projectId}`), 'navigation vers la fiche projet')
  })

  test('RetourDetail : le produit d\'un article est un lien vers /products/:id', async () => {
    await page.goto(`${URL}/retours/${retourId}`, { waitUntil: 'domcontentloaded' })
    const link = page.locator(`a[href$="/products/${productId}"]`)
    await link.first().waitFor({ state: 'visible', timeout: 10000 })
    await link.first().click()
    await page.waitForURL(u => u.toString().includes(`/products/${productId}`), { timeout: 10000 })
    assert.ok(page.url().includes(`/products/${productId}`), 'navigation vers la fiche produit')
  })
})
