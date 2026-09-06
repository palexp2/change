const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Design rules audit — pages modifiées', () => {
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

  // Rule 1 — DataTable migrations
  test('Automations page charge avec DataTable (barre d\'outils standard)', async () => {
    await page.goto(URL + '/automations', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('h1:has-text("Automations")', { timeout: 10000 })
    for (const label of ['Champs', 'Filtrer', 'Trier', 'Grouper']) {
      assert.ok(await page.locator(`button:has-text("${label}")`).first().isVisible(), `bouton ${label} absent`)
    }
  })

  test('Admin utilisateurs charge avec DataTable', async () => {
    await page.goto(URL + '/admin/utilisateurs', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('h2:has-text("Utilisateurs")', { timeout: 10000 })
    for (const label of ['Champs', 'Filtrer', 'Trier', 'Grouper']) {
      assert.ok(await page.locator(`button:has-text("${label}")`).first().isVisible(), `bouton ${label} absent`)
    }
  })

  // Rule 2 — SearchSelect pickers
  test('Nouvelle commande — picker Entreprise recherchable', async () => {
    await page.goto(URL + '/orders', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('h1:has-text("Commandes")', { timeout: 10000 })
    await page.click('button:has-text("Nouvelle commande")')
    // Wait for the modal title
    await page.waitForSelector('h2:has-text("Nouvelle commande")', { timeout: 5000 })
    // First SearchSelect trigger: a button with chevron-down inside the modal body
    const modalBody = page.locator('.bg-white.rounded-2xl').first()
    const trigger = modalBody.locator('button').filter({ has: page.locator('svg.lucide-chevron-down') }).first()
    await trigger.click()
    // Expect the search input to appear
    await page.waitForSelector('input[placeholder*="Recherche"]', { timeout: 2000 })
    assert.ok(await page.locator('input[placeholder*="Recherche"]').first().isVisible())
    await page.keyboard.press('Escape')
    const cancel = page.locator('button:has-text("Annuler")').last()
    if (await cancel.isVisible().catch(() => false)) await cancel.click()
  })

  // Rule 3 — autosave
  test('AutomationDetail — pas de bouton Enregistrer sur automation existante', async () => {
    await page.goto(URL + '/automations', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('h1:has-text("Automations")', { timeout: 10000 })
    // Look for a clickable row in the DataTable
    const rowEl = page.locator('div:has(button:has-text("Actif")), div:has(button:has-text("Inactif"))').first()
    if (!(await rowEl.isVisible().catch(() => false))) return // no data, skip
    await rowEl.click()
    await page.waitForURL(/\/automations\/[^\/]+/, { timeout: 5000 })
    // No "Enregistrer" button on existing automation
    const saveBtn = page.locator('button:has-text("Enregistrer")')
    const hasSave = await saveBtn.count()
    assert.equal(hasSave, 0, 'bouton Enregistrer ne devrait pas être présent sur automation existante')
  })
})
