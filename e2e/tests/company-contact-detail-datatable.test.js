const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

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
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

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

  // Onglets toujours présents dans CompanyDetail (achats est conditionnel au
  // quickbooks_vendor_id, donc exclu de la boucle).
  const TABS = ['contacts', 'commandes', 'support', 'envois', 'factures', 'abonnements', 'tâches', 'retours']

  // Le nav latéral des onglets de CompanyDetail contient l'onglet "Informations"
  // (absent de la nav globale du Layout) → on s'en sert pour cibler sans ambiguïté
  // les boutons d'onglet (certains noms, ex. "Envois", collisionnent avec la nav globale).
  const companyTabNav = () => page.locator('nav').filter({ hasText: 'Informations' })

  for (const tab of TABS) {
    test(`onglet ${tab} : DataTable rendu (recherche) + aucun <table> brut`, async () => {
      await page.goto(`${URL}/companies/${companyId}`, { waitUntil: 'domcontentloaded' })
      await page.waitForLoadState('networkidle')

      await companyTabNav().getByRole('button', { name: new RegExp(`^${tab}`, 'i') }).first().click()

      // La ViewToolbar de la DataTable rend toujours le champ de recherche,
      // même quand l'onglet est vide (état vide géré par la DataTable elle-même).
      await page.locator('input[placeholder="Rechercher..."]').first()
        .waitFor({ state: 'visible', timeout: 10000 })

      const tableCount = await page.locator('table').count()
      assert.equal(tableCount, 0, `l'onglet ${tab} ne doit plus contenir de <table> HTML (trouvé ${tableCount})`)
    })
  }

  test('clic sur une ligne contact (DataTable) navigue vers la fiche, dont les tâches sont une DataTable', async (t) => {
    if (!contactId) { t.skip('aucune entreprise avec contact trouvée'); return }
    await page.goto(`${URL}/companies/${companyId}`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle')
    await companyTabNav().getByRole('button', { name: /^contacts/i }).first().click()

    const row = page.locator('[data-row-id]').first()
    await row.waitFor({ state: 'visible', timeout: 8000 })
    const cursor = await row.evaluate(el => getComputedStyle(el).cursor)
    assert.equal(cursor, 'pointer', 'la ligne contact doit avoir cursor:pointer')

    await row.click()
    await page.waitForURL(u => /\/contacts\/\d+/.test(u.toString()), { timeout: 8000 })

    // ContactDetail : la section Tâches est désormais une DataTable.
    await page.locator('input[placeholder="Rechercher..."]').first()
      .waitFor({ state: 'visible', timeout: 10000 })
    const tableCount = await page.locator('table').count()
    assert.equal(tableCount, 0, `ContactDetail ne doit plus contenir de <table> HTML (trouvé ${tableCount})`)
  })
})
