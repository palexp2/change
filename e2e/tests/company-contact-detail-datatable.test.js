const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
// `ERP_TOKEN` : JWT injecté en localStorage quand le mot de passe n'est pas
// disponible.
const TOKEN = process.env.ERP_TOKEN
if (!PASS && !TOKEN) throw new Error('ERP_PASS ou ERP_TOKEN requis')

// Migration des sous-tableaux liés de CompanyDetail (contacts, commandes,
// support, envois, factures, abonnements, tâches, achats, retours) et des tâches
// de ContactDetail : du <table> HTML brut vers <DataTable>.
//
// Vérifie que chaque onglet migré rend bien une DataTable (barre d'outils avec
// champ de recherche) et qu'aucun <table> HTML brut ne subsiste. Aucune modale
// n'est ouverte → la seule source possible de <table> (AbonnementDetailModal)
// reste fermée. Lecture seule : aucun record créé ou muté, pas de cleanup DB.
describe('CompanyDetail / ContactDetail — sous-tableaux migrés en DataTable', () => {
  let browser, ctx, page, companyId, contactId

  before(async () => {
    browser = await chromium.launch()
    // Panneau au layout CRM : il lui faut de la place pour ses 3 colonnes.
    ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
    if (TOKEN) await ctx.addInitScript(t => localStorage.setItem('erp_token', t), TOKEN)
    page = await ctx.newPage()
    if (!TOKEN) {
      await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
      await page.fill('input[type="email"]', EMAIL)
      await page.fill('input[type="password"]', PASS)
      await page.click('button:has-text("Se connecter")')
      await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
    }

    // Cherche une entreprise ayant au moins un contact (pour tester le clic-nav).
    const found = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/companies?limit=all', { headers: { Authorization: `Bearer ${tok}` } })
      const j = await r.json()
      const list = j.data || j || []
      for (const c of list.slice(0, 60)) {
        const dr = await fetch(`/erp/api/companies/${c.id}`, { headers: { Authorization: `Bearer ${tok}` } })
        const d = await dr.json()
        if (Array.isArray(d.contacts) && d.contacts.length > 0) {
          return { companyId: c.id, contactId: d.contacts[0].id }
        }
      }
      return { companyId: list[0]?.id || null, contactId: null }
    })
    companyId = found.companyId
    contactId = found.contactId
    assert.ok(companyId, 'devrait trouver au moins une entreprise')
  })

  after(async () => { await browser?.close() })

  // Groupes de records liés toujours présents dans CompanyDetail (achats est
  // conditionnel au quickbooks_vendor_id, donc exclu de la boucle). Depuis le
  // layout CRM, chacun est une carte de la colonne de droite dont le titre
  // ouvre le tableau complet au centre.
  const TABS = ['contacts', 'projets', 'commandes', 'envois', 'factures', 'abonnements', 'tâches', 'retours']

  const openRelated = (key) => page.locator(`[data-testid="crm-card-${key}"] button`).nth(1).click()

  for (const tab of TABS) {
    test(`groupe ${tab} : DataTable rendu (recherche) + aucun <table> brut`, async () => {
      await page.goto(`${URL}/companies/${companyId}`, { waitUntil: 'domcontentloaded' })
      await page.waitForLoadState('networkidle')

      await openRelated(tab)

      // La DataTable rend toujours sa barre de lignes, même vide (l'état vide
      // est géré par la DataTable elle-même).
      await page.locator('[data-testid="datatable-grid-bar"]').first()
        .waitFor({ state: 'visible', timeout: 10000 })

      const tableCount = await page.locator('table').count()
      assert.equal(tableCount, 0, `l'onglet ${tab} ne doit plus contenir de <table> HTML (trouvé ${tableCount})`)
    })
  }

  test('clic sur une ligne contact (DataTable) navigue vers la fiche, dont les tâches sont une DataTable', async (t) => {
    if (!contactId) { t.skip('aucune entreprise avec contact trouvée'); return }
    await page.goto(`${URL}/companies/${companyId}`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle')
    await openRelated('contacts')

    const row = page.locator('[data-row-id]').first()
    await row.waitFor({ state: 'visible', timeout: 8000 })
    const cursor = await row.evaluate(el => getComputedStyle(el).cursor)
    assert.equal(cursor, 'pointer', 'la ligne contact doit avoir cursor:pointer')

    await row.click()
    await page.waitForURL(u => /\/contacts\/\d+/.test(u.toString()), { timeout: 8000 })

    // ContactDetail : les tâches sont une DataTable, ouverte au centre depuis
    // la carte « Tâches » de la colonne de droite.
    await page.locator('[data-testid="crm-card-tâches"] button').nth(1).click()
    await page.locator('[data-testid="datatable-grid-bar"]').first()
      .waitFor({ state: 'visible', timeout: 10000 })
    const tableCount = await page.locator('table').count()
    assert.equal(tableCount, 0, `ContactDetail ne doit plus contenir de <table> HTML (trouvé ${tableCount})`)
  })
})
