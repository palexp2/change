// Conformité règle CLAUDE.md « champs référence (FK) » : les FK texte restants
// des fiches détail doivent être des liens cliquables vers la fiche cible.
//
// - OrderDetail (header mode expédition) : order.company_name doit linker vers /companies/:id
// - SoumissionDetail (bouton retour)      : « Projet : … » doit linker vers /projects/:id
//
// Test purement en lecture (aucun record créé/modifié) → pas de cleanup ni de
// restauration. On résout dynamiquement une commande avec company_id et une
// soumission avec project_id via l'API.

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

describe('Détail — FK texte restants cliquables (Order / Soumission)', () => {
  let browser, page, token
  let orderId, companyId, soumissionId, projectId

  before(async () => {
    token = await apiToken()
    const auth = { headers: { Authorization: 'Bearer ' + token } }

    // Commande avec company_id
    const oList = await (await fetch(API + '/orders?limit=all', auth)).json()
    const oItems = oList.items || oList.data || oList
    const o = oItems.find(x => x.company_id && x.company_name)
    assert.ok(o, 'aucune commande avec company_id trouvée')
    orderId = o.id
    companyId = o.company_id

    // Soumission avec project_id
    const sList = await (await fetch(API + '/projets/soumissions?limit=all', auth)).json()
    const sItems = sList.items || sList.data || sList
    const s = sItems.find(x => x.project_id)
    assert.ok(s, 'aucune soumission avec project_id trouvée')
    soumissionId = s.id
    projectId = s.project_id

    browser = await chromium.launch()
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await login(page)
  })

  after(async () => {
    if (browser) await browser.close()
  })

  test('OrderDetail (mode expédition) : company_name linke vers /companies/:id', async () => {
    await page.goto(`${URL}/orders/${orderId}`, { waitUntil: 'domcontentloaded' })
    // Passer en mode expédition pour afficher le header concerné
    await page.click('button:has-text("Mode expédition")')
    const header = page.locator('[data-testid="expedition-view"]')
    await header.waitFor({ state: 'visible', timeout: 10000 })
    const link = header.locator(`a[href$="/companies/${companyId}"]`)
    await link.first().waitFor({ state: 'visible', timeout: 10000 })
    await link.first().click()
    await page.waitForURL(u => u.toString().includes(`/companies/${companyId}`), { timeout: 10000 })
    assert.ok(page.url().includes(`/companies/${companyId}`), 'navigation vers la fiche entreprise')
  })

  test('SoumissionDetail (bouton retour) : « Projet : … » linke vers /projects/:id', async () => {
    await page.goto(`${URL}/soumissions/${soumissionId}`, { waitUntil: 'domcontentloaded' })
    // Le bouton retour : un <a> contenant « Projet : »
    const back = page.locator(`a[href$="/projects/${projectId}"]:has-text("Projet")`)
    await back.first().waitFor({ state: 'visible', timeout: 10000 })
    await back.first().click()
    await page.waitForURL(u => u.toString().includes(`/projects/${projectId}`), { timeout: 10000 })
    assert.ok(page.url().includes(`/projects/${projectId}`), 'navigation vers la fiche projet')
  })
})
