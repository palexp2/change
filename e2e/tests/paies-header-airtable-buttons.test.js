const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Le sync Airtable de /paies est un bouton scindé unique dans l'en-tête :
// segment principal « Sync Airtable » (import direct) + segment icône
// (mapping, ouvre AirtableCoreMapModal). Fusionné depuis deux boutons séparés
// qui portaient le même libellé « Sync Airtable ». Test en lecture seule —
// aucun record créé, aucune configuration modifiée, aucun sync lancé.
describe('Paies — boutons Airtable dans l’en-tête (design standard)', () => {
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

  test('en-tête : bouton scindé unique Sync Airtable (import + mapping) ; l’ancien panneau a disparu', async () => {
    await page.goto(URL + '/paies', { waitUntil: 'domcontentloaded' })

    // Le bouton scindé est dans l'en-tête, à côté de « Nouvelle paie »
    const syncBtn = page.locator('[data-testid="paies-airtable-sync"]')
    const mapBtn = page.locator('[data-testid="paies-airtable-map-open"]')
    await syncBtn.waitFor({ state: 'visible', timeout: 15000 })
    await mapBtn.waitFor({ state: 'visible', timeout: 15000 })
    assert.match(await syncBtn.innerText(), /Sync Airtable/i)
    // Le segment mapping est une icône seule — plus de libellé dupliqué :
    // un seul bouton de la page affiche « Sync Airtable ».
    assert.equal(
      await page.locator('button:has-text("Sync Airtable")').count(),
      1,
      'un seul bouton doit afficher « Sync Airtable » (le segment sync du bouton scindé)'
    )

    // L'ancien panneau repliable n'existe plus
    assert.equal(
      await page.locator('button:has-text("Synchronisation Airtable")').count(),
      0,
      'le panneau repliable « Synchronisation Airtable » ne doit plus exister sur /paies'
    )

    // Le bouton Mapping ouvre bien la modale de mapping standard (2 onglets)
    await mapBtn.click()
    const dialog = page.locator('[role="dialog"]')
    await dialog.waitFor({ state: 'visible', timeout: 10000 })
    await page.waitForSelector('[data-testid="coremap-tab-paies"]', { timeout: 10000 })
    await page.waitForSelector('[data-testid="coremap-tab-paie_items"]', { timeout: 10000 })
    // Fermeture sans rien enregistrer
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden', timeout: 5000 })
  })
})
