// Vérifie que la section "Produits" du modal de détail d'un abonnement affiche
// un total avant taxes correspondant à la somme des "Total" de chaque ligne.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

function parseAmount(text) {
  // Format "12.34 cad" ou "1,234.56 usd" → 1234.56
  // Reconnaît aussi le minus typographique − (U+2212) pour les lignes Rabais.
  const m = text.match(/[-−]?[\d,]+\.\d+/)
  if (!m) return null
  return parseFloat(m[0].replace(/,/g, '').replace(/^−/, '-'))
}

describe('Abonnements — total avant taxes section Produits', () => {
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

  test('le footer "Total avant taxes" est égal à la somme des totaux de lignes', async () => {
    await page.goto(`${URL}/abonnements`, { waitUntil: 'networkidle' })
    await page.waitForSelector('text=/\\d+\\s+lignes?/', { timeout: 10000 })

    // Ouvrir le premier abonnement (cf. abonnement-detail-modal.test.js)
    const link = page.locator('a[href*="/companies/"]').first()
    await link.waitFor({ state: 'visible', timeout: 5000 })
    const box = await link.boundingBox()
    assert.ok(box)
    await page.mouse.click(box.x + box.width + 200, box.y + box.height / 2)

    await page.waitForSelector('text=/Détails de l.abonnement/', { timeout: 5000 })

    // Attendre que les détails Stripe soient chargés (fin du spinner)
    await page.waitForSelector('h4:has-text("Produits")', { timeout: 10000 })

    // Récupérer le tableau Produits
    const productsHeading = page.locator('h4:has-text("Produits")')
    const productsTable = productsHeading.locator('xpath=following-sibling::div[1]//table')
    await productsTable.waitFor({ state: 'visible' })

    // Sommer les totaux des lignes (4ème colonne)
    const rowTotals = await productsTable.locator('tbody tr').evaluateAll(rows =>
      rows.map(r => r.children[3]?.textContent?.trim() || '')
    )
    assert.ok(rowTotals.length > 0, 'au moins une ligne produit attendue')

    // Somme des montants (items positifs + éventuelle ligne Rabais négative).
    const sum = rowTotals.reduce((s, txt) => {
      const v = parseAmount(txt)
      return v != null ? s + v : s
    }, 0)

    // Lire le footer
    const footer = productsTable.locator('tfoot tr')
    await footer.waitFor({ state: 'visible' })
    const footerText = (await footer.textContent()) || ''
    assert.match(footerText, /Total avant taxes/i, 'le footer doit contenir "Total avant taxes"')

    const footerAmount = parseAmount(footerText)
    assert.ok(footerAmount != null, `montant non trouvé dans footer: "${footerText}"`)

    // Tolérance arrondi (< 0.01)
    assert.ok(
      Math.abs(footerAmount - sum) < 0.01,
      `total footer (${footerAmount}) ≠ somme des lignes (${sum.toFixed(2)})`
    )
  })
})
