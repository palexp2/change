// Vérifie que la colonne "Arbre troubleshoot" a été retirée du tableau
// "Billets par mois" sur le dashboard
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Dashboard — Billets par mois : colonne Arbre removed', () => {
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

  after(async () => { await browser?.close() })

  test('la page dashboard est chargée', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })
    const heading = page.locator('h1, h2').first()
    await heading.waitFor({ state: 'visible', timeout: 5000 })
    assert.ok(await heading.isVisible(), 'aucun titre sur le dashboard')
  })

  test('le tableau Billets par mois existe', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })
    const billetsSection = page.locator('h2:has-text("Billets par mois")')
    await billetsSection.waitFor({ state: 'visible', timeout: 10000 })
    assert.ok(await billetsSection.isVisible(), 'section Billets par mois non trouvée')
  })

  test('la colonne Arbre troubleshoot est masquée', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })

    // Attendre le chargement de la section
    const billetsSection = page.locator('h2:has-text("Billets par mois")')
    await billetsSection.waitFor({ state: 'visible', timeout: 10000 })

    // Chercher l'en-tête de colonne "Arbre troubleshoot" dans la page
    // Elle ne doit pas exister
    const arbreHeader = page.locator(':text("Arbre troubleshoot")')
    const count = await arbreHeader.count()
    assert.equal(count, 0, `la colonne Arbre troubleshoot ne doit pas être visible (trouvée ${count} fois)`)
  })

  test('les colonnes attendues sont présentes', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })

    // Attendre le chargement
    const billetsSection = page.locator('h2:has-text("Billets par mois")')
    await billetsSection.waitFor({ state: 'visible', timeout: 10000 })

    // Vérifier les colonnes restantes
    const expectedColumns = ['Semaine', 'Billets', 'Ligne 2', '> 15 min']

    for (const colName of expectedColumns) {
      const col = page.locator(`th:has-text("${colName}")`)
      const count = await col.count()
      assert.ok(count > 0, `colonne attendue "${colName}" non trouvée`)
    }
  })
})
