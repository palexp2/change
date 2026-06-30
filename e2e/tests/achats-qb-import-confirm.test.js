const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// « Importer depuis QB » d'AchatsFournisseurs crée/met à jour en cascade des
// factures fournisseurs et dépenses depuis QuickBooks. On vérifie qu'un clic
// ouvre une modale de confirmation listant ces side effects (et NE lance PAS
// l'import), conformément à la règle de confirmation des side effects de CLAUDE.md.
// Le test ne confirme jamais l'import — il ne faut pas lancer un vrai import QB
// contre la prod. La route est interceptée comme garde-fou.
describe('AchatsFournisseurs — confirmation « Importer depuis QB »', () => {
  let browser, ctx, page
  let importCalled = false

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()

    // Garde-fou : si la route d'import QB est appelée, on le détecte pour faire
    // échouer le test (la modale ne doit rien lancer tant qu'on ne confirme pas).
    await page.route('**/api/connectors/sync/qb-import', route => {
      importCalled = true
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"bills":{"inserted":0,"updated":0},"depenses":{"inserted":0,"updated":0}}' })
    })

    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => { await browser?.close() })

  test('clic sur « Importer depuis QB » ouvre une modale de récap sans lancer l\'import', async () => {
    await page.goto(`${URL}/achats-fournisseurs`, { waitUntil: 'networkidle' })

    const importBtn = page.locator('[data-testid="qb-import-btn"]')
    await importBtn.waitFor({ state: 'visible', timeout: 10000 })
    await importBtn.click()

    // La modale de confirmation doit apparaître
    const modalTitle = page.locator('text=Importer depuis QuickBooks ?')
    await modalTitle.waitFor({ state: 'visible', timeout: 5000 })

    // Elle liste les side effects (cascade factures fournisseurs + dépenses)
    const modalText = await page.locator('.whitespace-pre-line').first().innerText()
    assert.ok(/[Ff]actures fournisseurs/.test(modalText), 'mention des factures fournisseurs')
    assert.ok(/[Dd]épenses/.test(modalText), 'mention des dépenses')

    // L'import ne doit PAS avoir été lancé par la simple ouverture de la modale
    assert.equal(importCalled, false, 'l\'import ne doit pas démarrer avant confirmation')

    // Annuler ferme la modale sans rien lancer
    await page.locator('button:has-text("Annuler")').click()
    await modalTitle.waitFor({ state: 'hidden', timeout: 5000 })
    assert.equal(importCalled, false, 'Annuler ne doit rien lancer')
  })
})
