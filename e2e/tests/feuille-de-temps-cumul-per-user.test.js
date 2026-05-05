const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// La sélection de codes du Cumul mensuel doit être indépendante par employé visualisé :
// changer d'employé ne doit pas leak les codes choisis pour un autre.
describe('Feuille de temps — Cumul mensuel : sélection de codes par employé', () => {
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
    await page.goto(URL + '/feuille-de-temps', { waitUntil: 'domcontentloaded' })
    // Vide d'éventuelles sélections résiduelles localStorage avant test
    await page.evaluate(() => {
      Object.keys(localStorage)
        .filter(k => k.startsWith('fdt:cumul-codes'))
        .forEach(k => localStorage.removeItem(k))
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
  })

  after(async () => {
    await page.evaluate(() => {
      Object.keys(localStorage)
        .filter(k => k.startsWith('fdt:cumul-codes'))
        .forEach(k => localStorage.removeItem(k))
    })
    await browser?.close()
  })

  test('ajouter un code sur ma feuille → ne doit pas apparaître pour un autre employé', async () => {
    // Sur ma propre feuille, ajouter le premier code disponible
    await page.locator('[data-testid="monthly-cumul"] button:has-text("Ajouter un code")').click()
    // Le picker ouvre une popup via portal — récupérer le 1er bouton de la liste filtrée
    const firstOption = page.locator('div[style*="position: fixed"] button').nth(1) // [0] = "— aucun —"
    const firstName = (await firstOption.innerText()).trim()
    await firstOption.click()
    // Une chip apparaît dans le cumul
    await page.waitForSelector(`[data-testid="monthly-cumul"] :has-text("${firstName}")`, { timeout: 2000 })

    // Switcher vers Martin Audesse
    await page.locator('[data-testid="user-picker"] button').click()
    await page.fill('input[placeholder="Rechercher…"]', 'Martin')
    await page.locator('button:has-text("Martin Audesse")').first().click()
    await page.waitForSelector('[data-testid="viewing-other-banner"]')

    // Vérifie : pas de code dans le cumul de Martin (sa storage key est vide)
    const chipsCount = await page.locator('[data-testid="monthly-cumul"] [data-testid^="cumul-row-"]').count()
    assert.equal(chipsCount, 0, `Martin ne doit avoir aucun code sélectionné, vu ${chipsCount}`)
  })

  test('ajouter un autre code sur la feuille de Martin → revenir à la mienne ramène la sélection initiale', async () => {
    // Ajoute un code différent sur la feuille de Martin
    await page.locator('[data-testid="monthly-cumul"] button:has-text("Ajouter un code")').click()
    const firstOption = page.locator('div[style*="position: fixed"] button').nth(1)
    const martinCode = (await firstOption.innerText()).trim()
    await firstOption.click()
    await page.waitForSelector(`[data-testid="monthly-cumul"] :has-text("${martinCode}")`)

    // Revenir à ma feuille
    await page.locator('[data-testid="viewing-other-banner"] button:has-text("Revenir à ma feuille")').click()
    await page.waitForSelector('[data-testid="viewing-other-banner"]', { state: 'detached' })

    // La sélection précédente (du test 1) doit être restaurée — exactement 1 code, pas plus
    const myChips = await page.locator('[data-testid="monthly-cumul"] [data-testid^="cumul-row-"]').count()
    assert.equal(myChips, 1, `Sur ma feuille on doit avoir 1 code restauré, vu ${myChips}`)
  })
})
