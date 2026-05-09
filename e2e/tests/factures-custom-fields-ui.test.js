const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS || 'saluerlessoviets'

// UI : la page Factures expose un bouton « + Ajouter un champ » via la
// configuration de colonnes du DataTable, et le champ formule
// "Mois du document" apparaît dans la liste des colonnes disponibles.
describe('Factures — UI champs custom', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => { await browser?.close() })

  test('la page Factures charge sans erreur JS', async () => {
    const errors = []
    page.on('pageerror', e => errors.push(e.message))
    page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()) })
    await page.goto(URL + '/factures', { waitUntil: 'networkidle' })
    await page.waitForSelector('h1:has-text("Factures clients")', { timeout: 8000 })
    // Le DataTable utilise un layout en <div> avec virtualization (pas <table>)
    // — on attend juste l'indicateur "X lignes" qui apparaît dans le toolbar.
    await page.waitForFunction(
      () => /\d+\s+lignes?/.test(document.body.innerText),
      null,
      { timeout: 10000 },
    )
    assert.deepEqual(errors, [], `aucune erreur JS attendue, reçu: ${errors.join(' | ')}`)
  })

  test('le champ formule "Mois du document" apparaît dans le panneau Champs', async () => {
    await page.goto(URL + '/factures', { waitUntil: 'networkidle' })
    await page.waitForSelector('h1:has-text("Factures clients")', { timeout: 8000 })

    // Le bouton "Champs" du DataTable ouvre le panneau de visibilité des
    // colonnes — c'est là qu'on doit voir notre champ formule.
    await page.click('button:has-text("Champs")')
    await page.waitForTimeout(500)

    const text = await page.evaluate(() => document.body.innerText)
    assert.ok(
      text.includes('Mois du document'),
      `Le champ formule "Mois du document" doit apparaître après ouverture du panneau Champs. Body text: ${text.slice(0, 400)}`,
    )
  })

  test('le bouton "Ajouter un champ" est présent', async () => {
    await page.goto(URL + '/factures', { waitUntil: 'networkidle' })
    await page.waitForSelector('h1:has-text("Factures clients")', { timeout: 8000 })

    const addBtn = page.locator('button[aria-label="Ajouter un champ"]')
    await addBtn.first().waitFor({ state: 'attached', timeout: 5000 })
    assert.ok(await addBtn.count() > 0, 'Le bouton "Ajouter un champ" doit être présent (passé via prop onAddCustomField)')
  })
})
