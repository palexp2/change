const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Factures — liste colonnes complètes', () => {
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

  test('API list renvoie order_number + total_amount + amount_before_tax_cad', async () => {
    await page.goto(URL + '/factures', { waitUntil: 'domcontentloaded' })
    const rows = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/projets/factures?limit=all', {
        headers: { Authorization: `Bearer ${token}` },
      })
      return r.json()
    })
    assert.ok(Array.isArray(rows.data), 'réponse doit contenir data[]')

    // total_amount doit être populé (avant fix: 0 via colonne inexistante total_cad)
    const withTotal = rows.data.filter(f => Number(f.total_amount) !== 0)
    assert.ok(withTotal.length > 100, `total_amount doit être exposé dans le JSON (trouvé ${withTotal.length} !=0)`)

    // amount_before_tax_cad exposé aussi
    const withSubtotal = rows.data.filter(f => Number(f.amount_before_tax_cad) !== 0)
    assert.ok(withSubtotal.length > 100, `amount_before_tax_cad doit être exposé (trouvé ${withSubtotal.length})`)

    // order_number doit être exposé pour les factures avec order_id
    const withOrder = rows.data.filter(f => f.order_id)
    assert.ok(withOrder.length > 0, 'au moins une facture avec order_id attendue')
    const withOrderNumber = withOrder.filter(f => f.order_number)
    assert.equal(
      withOrderNumber.length, withOrder.length,
      `toutes les factures avec order_id doivent avoir order_number (${withOrderNumber.length}/${withOrder.length})`
    )
  })

  test('Menu "Champs" expose order_number et Avant taxes (CAD)', async () => {
    await page.goto(URL + '/factures', { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(800)
    await page.locator('button', { hasText: /^Champs/ }).first().click()
    await page.waitForTimeout(200)

    // Rechercher "Commande" → doit trouver une option
    await page.fill('input[placeholder="Rechercher..."]', 'Commande')
    await page.waitForTimeout(150)
    const commandeLabel = await page.locator('.w-64 label', { hasText: /^Commande$/ }).count()
    assert.ok(commandeLabel > 0, 'colonne "Commande" doit être dans le panneau Champs')

    // Rechercher "Avant taxes"
    await page.fill('input[placeholder="Rechercher..."]', 'Avant taxes')
    await page.waitForTimeout(150)
    const cadLabel = await page.locator('.w-64 label', { hasText: /Avant taxes/ }).count()
    assert.ok(cadLabel > 0, 'colonne "Avant taxes (CAD)" doit être dans le panneau Champs')
  })
})
