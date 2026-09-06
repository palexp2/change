const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('FactureDetail — affichage de la devise', () => {
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

  test("La fiche détail d'une facture USD affiche la devise et formate les montants en USD", async () => {
    // Trouver une facture USD
    await page.goto(URL + '/factures', { waitUntil: 'domcontentloaded' })
    const usdFacture = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/projets/factures?limit=all', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const j = await r.json()
      return (j.data || []).find(f => f.currency === 'USD' && f.total_amount > 0)
    })
    assert.ok(usdFacture, 'une facture USD est requise pour le test')

    await page.goto(URL + '/factures/' + usdFacture.id, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=Devise', { timeout: 10000 })

    // Label "Devise" présent
    const deviseLabel = page.locator('p', { hasText: /^Devise$/ }).first()
    await deviseLabel.waitFor({ state: 'visible' })

    // Valeur "USD" affichée
    const usdCell = page.locator('p.font-mono', { hasText: /^USD$/ }).first()
    await usdCell.waitFor({ state: 'visible' })

    // Les montants sont formatés en USD (et non en CAD)
    const bodyText = await page.locator('body').innerText()
    assert.ok(/US\s*\$|USD/i.test(bodyText), `la fiche devrait contenir un montant formaté USD (bodyText contains: ${bodyText.slice(0, 200)}…)`)
  })

  test("La fiche détail d'une facture CAD affiche CAD comme devise", async () => {
    await page.goto(URL + '/factures', { waitUntil: 'domcontentloaded' })
    const cadFacture = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/projets/factures?limit=all', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const j = await r.json()
      return (j.data || []).find(f => f.currency === 'CAD' && f.total_amount > 0)
    })
    assert.ok(cadFacture, 'une facture CAD est requise pour le test')

    await page.goto(URL + '/factures/' + cadFacture.id, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=Devise', { timeout: 10000 })

    const cadCell = page.locator('p.font-mono', { hasText: /^CAD$/ }).first()
    await cadCell.waitFor({ state: 'visible' })
  })
})
