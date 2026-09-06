const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// « Sync tout » d'AirtableConfig déclenche un import massif multi-modules.
// On vérifie qu'un clic ouvre une modale de confirmation listant les modules
// (et NE lance PAS la sync), conformément à la règle de confirmation des side effects.
// Le test n'appuie jamais sur « Resynchroniser tout » — il ne faut pas lancer
// une vraie resynchro Airtable contre la prod.
describe('AirtableConfig — confirmation « Sync tout »', () => {
  let browser, ctx, page
  let syncAllCalled = false

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()

    // Garde-fou : si la route d'import massif est appelée, on le détecte pour
    // faire échouer le test (la modale ne doit rien lancer tant qu'on ne confirme pas).
    await page.route('**/api/connectors/sync/airtable-all', route => {
      syncAllCalled = true
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
    })

    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => { await browser?.close() })

  test('clic sur « Sync tout » ouvre une modale de récap sans lancer la sync', async () => {
    await page.goto(`${URL}/connectors`, { waitUntil: 'networkidle' })

    // Ouvre la carte Airtable
    await page.locator('button:has-text("Airtable")').first().click()
    await page.locator('button:has-text("Contacts")').first().waitFor({ state: 'visible', timeout: 5000 })

    // Clic sur « Sync tout »
    const syncAllBtn = page.locator('button:has-text("Sync tout")')
    await syncAllBtn.waitFor({ state: 'visible', timeout: 5000 })
    await syncAllBtn.click()

    // La modale de confirmation doit apparaître
    const modalTitle = page.locator('text=Resynchroniser tous les modules ?')
    await modalTitle.waitFor({ state: 'visible', timeout: 5000 })

    // Elle liste plusieurs modules (récap des side effects)
    for (const label of ['Contacts & entreprises', 'Commandes', 'Achats', 'Envois', 'Paies']) {
      const item = page.locator('li', { hasText: label })
      assert.ok(await item.first().isVisible(), `module "${label}" listé dans la modale`)
    }

    // La sync ne doit PAS avoir été lancée par la simple ouverture de la modale
    assert.equal(syncAllCalled, false, 'la sync ne doit pas démarrer avant confirmation')

    // Annuler ferme la modale sans rien lancer
    await page.locator('button:has-text("Annuler")').click()
    await modalTitle.waitFor({ state: 'hidden', timeout: 5000 })
    assert.equal(syncAllCalled, false, 'Annuler ne doit rien lancer')
  })
})
