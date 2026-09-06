const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie que le sélecteur de champ pour le tri (SortPanel) ouvre un picker
// avec une zone de recherche live qui filtre les options.
describe('Pipeline — sélecteur de champ pour le tri avec recherche', () => {
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

  test('le picker de tri permet de rechercher un champ', async () => {
    await page.goto(`${URL}/pipeline`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle')

    // Ouvre le panneau Trier
    await page.click('button:has-text("Trier")')
    // Clique sur "Ajouter un tri" pour avoir au moins une règle
    await page.click('button:has-text("Ajouter un tri")')

    // Le sélecteur de champ est maintenant un bouton (pas un <select>).
    // On le clique pour ouvrir le picker.
    const fieldBtn = page.locator('div.relative.flex-1 button.select').first()
    await fieldBtn.waitFor({ state: 'visible', timeout: 5000 })
    await fieldBtn.click()

    // Le portal contient l'input de recherche.
    const searchInput = page.locator('#field-select-portal input[placeholder*="Rechercher"]')
    await searchInput.waitFor({ state: 'visible', timeout: 5000 })

    // On compte les options avant filtre
    const optionsBefore = await page.locator('#field-select-portal button').count()
    assert.ok(optionsBefore > 5, `Devrait avoir plusieurs champs disponibles, vu : ${optionsBefore}`)

    // Tape "valeur" pour filtrer
    await searchInput.fill('valeur')
    await page.waitForTimeout(150)
    const optionsAfter = await page.locator('#field-select-portal button').count()
    assert.ok(optionsAfter < optionsBefore, `La recherche doit réduire le nombre d'options (${optionsBefore} → ${optionsAfter})`)
    assert.ok(optionsAfter >= 1, 'Au moins un champ doit matcher "valeur"')

    // Vérifie qu'une option matche bien le terme
    const labels = await page.locator('#field-select-portal button').allTextContents()
    const hasMatch = labels.some(l => l.toLowerCase().includes('valeur'))
    assert.ok(hasMatch, `Une option devrait contenir "valeur", vu : ${labels.join(', ')}`)
  })
})
