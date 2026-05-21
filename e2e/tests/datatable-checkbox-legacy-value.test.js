// Vérifie que la colonne checkbox dynamique (ex « Besoin d'un numéro de série »)
// affiche bien ✓ lorsque la valeur DB historique est la string "1.0" (héritage
// d'une vieille sync Airtable). Auparavant le DataTable ne reconnaissait que
// 1, true et "1" — "1.0" tombait sur la branche "—".
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const ROW_SEL = 'div[style*="display: grid"][style*="position: absolute"]'

describe('DataTable — checkbox legacy "1.0" value', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } })
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

  test('Module d\'activation V2 (sku 1482, valeur DB "1.0") affiche ✓ dans la vue Valeur inventaire', async () => {
    await page.goto(URL + '/products', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector(ROW_SEL, { timeout: 15000 })

    // Bascule vers la vue « Valeur inventaire » qui inclut déjà la colonne
    // besoin_d_un_numero_de_serie dans ses visible_columns et n'a pas de filtre
    // sur la colonne quantite_a_commander.
    await page.click('button:has-text("Valeur inventaire")')
    await page.waitForTimeout(800)

    // Filtre via la recherche pour ne garder que Module d'activation V2 (sku 1482)
    const searchBox = page.locator('input[placeholder*="Recherche" i]').first()
    await searchBox.fill('1482')
    await page.waitForTimeout(800)

    // Trouve la ligne contenant le sku 1482 et inspecte le rendu de besoin_…
    const rowInfo = await page.evaluate((rowSel) => {
      const rows = document.querySelectorAll(rowSel)
      for (const r of rows) {
        const text = r.textContent || ''
        if (text.includes("Module d'activation V2")) {
          return {
            text,
            hasCheckmark: text.includes('✓'),
            // Détecte le cas du bug : "1.0" affiché en string brute
            hasRawOneDotZero: /\b1\.0\b/.test(text),
          }
        }
      }
      return null
    }, ROW_SEL)

    assert.ok(rowInfo, 'la ligne Module d\'activation V2 (sku 1482) devrait être visible')
    assert.equal(
      rowInfo.hasCheckmark, true,
      `la ligne devrait contenir ✓ pour besoin_d_un_numero_de_serie (valeur DB "1.0"). Texte: ${rowInfo.text.slice(0, 300)}`
    )
    assert.equal(
      rowInfo.hasRawOneDotZero, false,
      `la valeur "1.0" ne doit pas être affichée en brut — c'est le bug d'origine. Texte: ${rowInfo.text.slice(0, 300)}`
    )
  })
})
