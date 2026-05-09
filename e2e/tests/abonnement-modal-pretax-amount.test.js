// Vérifie que le montant affiché en haut à droite du modal de détail d'un
// abonnement correspond au sous-total avant taxes (somme des lignes - rabais),
// pas au montant TTC ou un autre dérivé.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

function parseAmount(text) {
  // Footer Stripe: "12.34 cad" ou "1,234.56 cad"
  const m = text.match(/[-−]?[\d,]+\.\d+/)
  if (!m) return null
  return parseFloat(m[0].replace(/,/g, '').replace(/^−/, '-'))
}

function parseCadDisplay(text) {
  // Format fr-CA Intl: "1 234,56 $" ou "1234,56 $". Retire NBSP, remplace
  // virgule décimale, retire le symbole monétaire.
  const m = text.replace(/ | /g, ' ').match(/-?\d[\d\s]*,\d+/)
  if (!m) return null
  return parseFloat(m[0].replace(/\s/g, '').replace(',', '.'))
}

describe('Abonnement — montant en-tête modal = total avant taxes', () => {
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

  test('le montant en haut à droite égale le "Total avant taxes" du tableau Produits', async () => {
    await page.goto(`${URL}/abonnements`, { waitUntil: 'networkidle' })
    await page.waitForSelector('text=/\\d+\\s+lignes?/', { timeout: 10000 })

    // On veut un abonnement CAD pour comparer header (toujours en CAD via fmtCad)
    // vs footer (en devise du sub). Itère jusqu'à en trouver un, max 8 essais.
    const links = await page.locator('a[href*="/companies/"]').all()
    const maxTries = Math.min(8, links.length)
    let footerAmount = null
    let headerText = null
    let lastFooterText = null

    for (let i = 0; i < maxTries; i++) {
      const link = links[i]
      const box = await link.boundingBox()
      if (!box) continue
      await page.mouse.click(box.x + box.width + 200, box.y + box.height / 2)
      await page.waitForSelector('text=/Détails de l.abonnement/', { timeout: 5000 })
      await page.waitForSelector('h4:has-text("Produits")', { timeout: 10000 })

      const productsHeading = page.locator('h4:has-text("Produits")')
      const productsTable = productsHeading.locator('xpath=following-sibling::div[1]//table')
      const footer = productsTable.locator('tfoot tr')
      await footer.waitFor({ state: 'visible' })
      const footerText = (await footer.textContent()) || ''
      lastFooterText = footerText

      if (/\bcad\b/i.test(footerText)) {
        footerAmount = parseAmount(footerText)
        const headerLoc = page.locator('[data-testid="abo-modal-cycle-amount"]')
        await headerLoc.waitFor({ state: 'visible', timeout: 5000 })
        headerText = (await headerLoc.textContent()) || ''
        break
      }

      // Pas CAD → fermer le modal (clic sur backdrop) et essayer le suivant
      await page.locator('div.fixed.inset-0.bg-black\\/50').click({ position: { x: 5, y: 5 } })
      await page.waitForSelector('text=/Détails de l.abonnement/', { state: 'hidden', timeout: 5000 })
    }

    assert.ok(footerAmount != null && headerText != null,
      `aucun abonnement CAD trouvé sur ${maxTries} essais (dernier footer: "${lastFooterText}")`)

    // Le header doit indiquer "avant taxes"
    assert.match(headerText, /av\.\s*tx|avant taxe/i,
      `header doit indiquer "avant taxes" : "${headerText}"`)

    const headerValue = parseCadDisplay(headerText)
    assert.ok(headerValue != null, `montant non trouvé dans header: "${headerText}"`)

    assert.ok(
      Math.abs(headerValue - footerAmount) < 0.01,
      `header (${headerValue}) ≠ total avant taxes du tableau (${footerAmount.toFixed(2)})`
    )
  })
})
