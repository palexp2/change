const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// La modale « Mapping des champs » (AirtableCoreMapModal) doit afficher, comme
// Airtable, des en-têtes de colonnes indiquant clairement quelle colonne liste
// les champs ERP et laquelle liste les champs Airtable. Test en lecture seule —
// aucun record créé ni configuration modifiée.
describe('Paies — en-têtes de colonnes dans la modale de mapping', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => {
    await browser?.close()
  })

  test('les en-têtes « Champ ERP » / « Champ Airtable » sont visibles pour les deux onglets', async () => {
    await page.goto(URL + '/paies', { waitUntil: 'domcontentloaded' })

    // Ouvre la modale depuis le bouton « Mapping Airtable » de l'en-tête
    // (même pattern que Products/Orders/Factures)
    await page.click('[data-testid="paies-airtable-map-open"]')
    await page.waitForSelector('[role="dialog"]', { timeout: 10000 })

    // Onglet Paies (actif par défaut)
    const headersPaies = page.locator('[data-testid="coremap-paies-headers"]')
    await headersPaies.waitFor({ state: 'visible', timeout: 15000 })
    assert.match(await headersPaies.innerText(), /Champ ERP/i)
    assert.match(await headersPaies.innerText(), /Champ Airtable/i)

    // Les en-têtes précèdent bien les lignes de mapping (au-dessus du premier picker)
    const headerBox = await headersPaies.boundingBox()
    const firstPicker = page.locator('[role="dialog"] [data-testid^="coremap-paies-"]:not([data-testid="coremap-paies-headers"])').first()
    if (await firstPicker.count()) {
      const pickerBox = await firstPicker.boundingBox()
      assert.ok(headerBox && pickerBox && headerBox.y < pickerBox.y, 'les en-têtes doivent être au-dessus des lignes de mapping')
    }

    // Onglet Items de paie
    await page.click('[data-testid="coremap-tab-paie_items"]')
    const headersItems = page.locator('[data-testid="coremap-paie_items-headers"]')
    await headersItems.waitFor({ state: 'visible', timeout: 15000 })
    assert.match(await headersItems.innerText(), /Champ ERP/i)
    assert.match(await headersItems.innerText(), /Champ Airtable/i)
  })
})
