const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('ProductDetail — VendorSelect fermé au chargement', () => {
  let browser, ctx, page, productId

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    const picked = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const res = await fetch('/erp/api/products?limit=all', { headers: { Authorization: `Bearer ${token}` } })
      const data = await res.json()
      const list = data.data || data
      const p = list.find(x => x.supplier_company_id)
      return p?.id || null
    })
    productId = picked
    assert.ok(productId, 'aucun produit avec supplier_company_id trouvé')
  })

  after(async () => { await browser?.close() })

  test('le menu fournisseur ne se déploie pas automatiquement', async () => {
    await page.goto(`${URL}/products/${productId}`, { waitUntil: 'networkidle' })
    // Laisser le temps aux effets async (debounce 200ms + fetch)
    await page.waitForTimeout(800)

    // Cherche le <input placeholder="Nom du fournisseur…"> et vérifie qu'il n'y a PAS
    // de <ul> frère ouvert à côté (celui rendu par VendorSelect quand open=true).
    const vendorInput = page.locator('input[placeholder="Nom du fournisseur…"]')
    await vendorInput.waitFor({ state: 'visible', timeout: 5000 })

    // Le <ul> dropdown est frère dans le même wrapper .relative
    const dropdownCount = await page.locator('input[placeholder="Nom du fournisseur…"] ~ ul').count()
    assert.strictEqual(dropdownCount, 0, 'le menu fournisseur ne doit pas être ouvert au chargement')
  })

  test('le menu fournisseur s\'ouvre au focus après frappe', async () => {
    const vendorInput = page.locator('input[placeholder="Nom du fournisseur…"]')
    const initialValue = await vendorInput.inputValue()
    assert.ok(initialValue.length > 0, 'valeur initiale attendue')

    // Simuler un clic + frappe : on efface un caractère et on le remet, le menu doit s'ouvrir
    await vendorInput.click()
    await vendorInput.press('End')
    await vendorInput.press('Backspace')
    await page.waitForTimeout(400)

    const dropdownCount = await page.locator('input[placeholder="Nom du fournisseur…"] ~ ul').count()
    assert.strictEqual(dropdownCount, 1, 'le menu fournisseur doit s\'ouvrir après édition')

    // Remettre la valeur d'origine pour ne rien casser
    await vendorInput.fill(initialValue)
    await page.keyboard.press('Escape')
  })
})
