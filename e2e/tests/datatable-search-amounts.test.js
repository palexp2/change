// Vérifie que la recherche du DataTable matche aussi les colonnes de montant
// (et non plus seulement les colonnes texte). Régression : taper "386" sur la
// page Factures ne retournait pas W8DJE5IA-0002 (total_amount=386.32) parce
// que searchFields n'incluait que document_number / company_name / project_name
// / order_number.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('DataTable — recherche par montant', () => {
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

  test('Factures : "386" matche W8DJE5IA-0002 (total_amount=386.32)', async () => {
    await page.goto(`${URL}/factures`, { waitUntil: 'domcontentloaded' })
    // Bascule sur la vue « Toutes les factures » pour ne pas être filtré par
    // la pill par défaut (« Achats », qui exclut les abonnements).
    const allPill = page.locator('button', { hasText: /^Toutes les factures$/ }).first()
    await allPill.waitFor({ state: 'visible', timeout: 15000 })
    await allPill.click()
    const search = page.locator('input[placeholder="Rechercher..."]').first()
    await search.waitFor({ state: 'visible', timeout: 15000 })
    // Attend que la liste soit peuplée — guette le compteur "X ligne(s)" du toolbar.
    await page.waitForFunction(() => {
      const m = document.body.innerText.match(/(\d[\d\s]*)\s*ligne/i)
      return m && parseInt(m[1].replace(/\s/g, ''), 10) > 0
    }, { timeout: 30000 })
    // Compte avant filtre.
    const before = await page.evaluate(() => {
      const m = document.body.innerText.match(/(\d[\d\s]*)\s*ligne/i)
      return m ? parseInt(m[1].replace(/\s/g, ''), 10) : 0
    })
    await search.fill('386')
    // Attend que le compteur de lignes change (filtrage appliqué).
    await page.waitForFunction((prev) => {
      const m = document.body.innerText.match(/(\d[\d\s]*)\s*ligne/i)
      const cur = m ? parseInt(m[1].replace(/\s/g, ''), 10) : 0
      return cur !== prev
    }, before, { timeout: 5000 })
    const after = await page.evaluate(() => {
      const m = document.body.innerText.match(/(\d[\d\s]*)\s*ligne/i)
      return m ? parseInt(m[1].replace(/\s/g, ''), 10) : 0
    })
    // Doit y avoir au moins 1 ligne (la facture W8DJE5IA-0002).
    assert.ok(after > 0, `recherche "386" doit retourner >0 lignes (avant: ${before}, après: ${after})`)
    // Liste les document_numbers visibles pour diagnostic.
    const visibleDocs = await page.evaluate(() => {
      return Array.from(document.body.innerText.matchAll(/[A-Z0-9]{8}-\d{4}/g)).map(m => m[0])
    })
    assert.ok(visibleDocs.includes('W8DJE5IA-0002'),
      `W8DJE5IA-0002 doit être dans les résultats (visibles: ${visibleDocs.join(', ')})`)
  })
})
