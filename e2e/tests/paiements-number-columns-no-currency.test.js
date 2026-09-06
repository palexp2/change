// Vérifie que sur la page /paiements, les colonnes de type nombre (« Montant »
// et « Montant (CAD) ») affichent un nombre brut, SANS symbole de devise ($).
// La devise reste portée par la colonne « Devise » dédiée et par le libellé
// « (CAD) » — pas par le montant lui-même.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Paiements — colonnes nombre sans devise', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
  })

  after(async () => { await browser?.close() })

  test('les cellules Montant / Montant (CAD) sont des nombres bruts (pas de $)', async () => {
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    await page.goto(`${URL}/paiements`, { waitUntil: 'networkidle' })
    await page.waitForSelector('text=/\\d+\\s+lignes?/', { timeout: 15000 })

    // Le DataTable est en mode tableur (onCellEdit fourni) : chaque cellule est un
    // div [data-grid-cell="<rowId>|<colId>"]. On cible les colonnes nombre amount
    // et amount_cad. Aucune ne doit contenir « $ ».
    const cells = page.locator('[data-grid-cell$="|amount"], [data-grid-cell$="|amount_cad"]')
    const count = await cells.count()
    assert.ok(count > 0, 'au moins une cellule de montant attendue')

    let checked = 0
    for (let i = 0; i < count; i++) {
      const txt = (await cells.nth(i).textContent() || '').trim()
      if (txt === '' || txt === '—') continue
      assert.ok(!txt.includes('$'), `cellule montant ne doit pas contenir « $ » : "${txt}"`)
      // Format nombre fr-CA attendu : chiffres, espaces (séparateur de milliers),
      // virgule décimale, éventuellement signe négatif. Pas de lettres/symbole.
      assert.match(txt, /^-?[\d\s  ]*\d(?:,\d+)?$/,
        `cellule montant mal formatée (attendu nombre brut) : "${txt}"`)
      checked++
    }
    assert.ok(checked > 0, 'au moins une cellule montant non vide attendue')
  })
})
