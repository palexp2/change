const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Page Achats — colonne Fournisseur liée à l\'entreprise', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
    await page.goto(URL + '/purchases', { waitUntil: 'networkidle' })
    await page.waitForSelector('h1:has-text("Achats")', { timeout: 10000 })
  })

  after(async () => { await browser?.close() })

  test('la colonne Fournisseur rend des liens cliquables /companies/<id>', async () => {
    const companyLinks = page.locator('a[href*="/companies/"]')
    await companyLinks.first().waitFor({ state: 'visible', timeout: 15000 })
    const count = await companyLinks.count()
    assert.ok(count > 0, `aucun lien /companies/ rendu (count=${count})`)

    // Vérifier qu'un lien a bien du texte (nom d'entreprise)
    const firstText = (await companyLinks.first().textContent() || '').trim()
    assert.ok(firstText.length > 0, 'lien fournisseur vide')

    // Aucun lien ne devrait afficher un ID Airtable brut ["recXXX..."]
    for (let i = 0; i < Math.min(count, 30); i++) {
      const txt = (await companyLinks.nth(i).textContent() || '').trim()
      assert.ok(!/^\["rec[A-Za-z0-9]+"\]$/.test(txt), `lien fournisseur contient un recId Airtable brut: ${txt}`)
    }
  })

  test('cliquer sur un fournisseur navigue vers /companies/:id', async () => {
    const link = page.locator('a[href*="/companies/"]').first()
    const href = await link.getAttribute('href')
    assert.ok(href && /\/companies\/[^/]+$/.test(href), `href inattendu: ${href}`)
    await link.click()
    await page.waitForURL(u => /\/companies\/[^/]+/.test(u.toString()), { timeout: 8000 })
  })
})
