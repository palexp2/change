// Fiches Entreprise et Contact : layout CRM (façon HubSpot) — informations à
// gauche, fil des événements au centre, records liés à droite. Remplace le test
// des sections empilées + scroll-spy (la nav de sections a disparu avec le
// layout en colonnes).
//
// Test 100 % lecture seule : aucun record créé ni modifié.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
// `ERP_TOKEN` : JWT injecté en localStorage quand le mot de passe n'est pas
// disponible (cf. e2e/README.md).
const TOKEN = process.env.ERP_TOKEN
if (!PASS && !TOKEN) throw new Error('ERP_PASS ou ERP_TOKEN requis')

const COMPANY_ID = '6365031a-97b1-4a76-80cd-e989c0e2334a'

async function login(page) {
  if (TOKEN) return
  await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASS)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 20000 })
}

// Titre d'une carte de records liés (le chevron est le premier bouton).
const cardTitle = (page, key) => page.locator(`[data-testid="crm-card-${key}"] button`).nth(1)

describe('Fiches Entreprise / Contact — layout CRM', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    // Large : le layout passe à 2 puis 1 colonne dans un panneau étroit.
    ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
    if (TOKEN) await ctx.addInitScript(t => localStorage.setItem('erp_token', t), TOKEN)
    page = await ctx.newPage()
    await login(page)
  })

  after(async () => { await browser?.close() })

  test('entreprise : 3 colonnes, fil au centre, cartes de records liés à droite', async () => {
    await page.goto(`${URL}/companies/${COMPANY_ID}`, { waitUntil: 'networkidle' })
    const layout = page.locator('[data-testid="crm-layout"]')
    await layout.waitFor({ state: 'visible', timeout: 20000 })
    assert.equal(await layout.getAttribute('data-crm-cols'), '3', 'le panneau devrait être assez large pour 3 colonnes')

    // Le fil est la vue par défaut du centre.
    assert.equal(await page.locator('[data-center-tab="fil"]').getAttribute('data-active'), 'true')

    // Chaque groupe de records liés a sa carte dans la colonne de droite.
    for (const key of ['contacts', 'projets', 'commandes', 'envois', 'factures', 'abonnements', 'retours', 'serials', 'tâches']) {
      assert.equal(
        await page.locator(`[data-testid="crm-card-${key}"]`).count(),
        1,
        `carte « ${key} » absente de la colonne des records liés`,
      )
    }
  })

  test('le titre d\'une carte ouvre le tableau complet au centre', async () => {
    await page.goto(`${URL}/companies/${COMPANY_ID}`, { waitUntil: 'networkidle' })
    await page.locator('[data-testid="crm-layout"]').waitFor({ state: 'visible', timeout: 20000 })

    await cardTitle(page, 'commandes').click()

    // Le tableau prend la place du fil, et l'onglet du centre suit.
    await page.locator('[data-testid="col-header-order_number"]').first().waitFor({ state: 'visible', timeout: 10000 })
    assert.equal(await page.locator('[data-center-tab="commandes"]').getAttribute('data-active'), 'true')

    // Retour au fil.
    await page.locator('[data-center-tab="fil"]').click()
    assert.equal(await page.locator('[data-center-tab="fil"]').getAttribute('data-active'), 'true')
  })

  test('contact : layout CRM avec entreprises liées et tâches à droite', async () => {
    const contactId = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/contacts?limit=1', { headers: { Authorization: `Bearer ${tok}` } })
      const j = await r.json()
      return (j.data || [])[0]?.id || null
    })
    assert.ok(contactId, 'devrait trouver au moins un contact')

    await page.goto(`${URL}/contacts/${contactId}`, { waitUntil: 'networkidle' })
    const layout = page.locator('[data-testid="crm-layout"]')
    await layout.waitFor({ state: 'visible', timeout: 20000 })
    assert.ok(Number(await layout.getAttribute('data-crm-cols')) >= 2, 'le contact devrait avoir au moins 2 colonnes')

    await page.locator('[data-testid="crm-card-entreprises"]').waitFor({ state: 'visible', timeout: 10000 })
    await page.locator('[data-testid="crm-card-tâches"]').waitFor({ state: 'visible', timeout: 10000 })
    assert.equal(await page.locator('[data-center-tab="fil"]').getAttribute('data-active'), 'true')
  })
})
