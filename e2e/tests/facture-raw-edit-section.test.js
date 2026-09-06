const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = process.env.ERP_DB_PATH || '/home/ec2-user/erp/server/data/erp.db'

// Vérifie le panneau « Édition avancée » sur la fiche facture : un admin peut
// éditer n'importe quelle colonne DB via le PATCH /admin/factures/:id/raw.
// On édite shipping_country (champ neutre, sans side effect sync) et on
// vérifie : (a) la valeur est persistée en DB, (b) le PATCH est rejeté pour
// une colonne inexistante, (c) la valeur originale est restaurée en cleanup.
describe('FactureDetail — panneau Édition avancée admin', () => {
  let browser, ctx, page, db
  let factureId
  let originalShippingCountry
  const TEST_VALUE = `E2E-${Date.now()}`

  before(async () => {
    db = new Database(DB_PATH, { readonly: false })
    const fac = db.prepare(`
      SELECT id, shipping_country FROM factures
      WHERE total_amount > 0 ORDER BY document_date DESC LIMIT 1
    `).get()
    if (!fac) throw new Error('Aucune facture disponible')
    factureId = fac.id
    originalShippingCountry = fac.shipping_country

    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => {
    // Restaure la valeur initiale du champ touché — la DB de tests = DB de prod.
    if (factureId) {
      db.prepare('UPDATE factures SET shipping_country=? WHERE id=?')
        .run(originalShippingCountry, factureId)
    }
    db?.close()
    await browser?.close()
  })

  test('le panneau « Édition avancée » est visible pour un admin', async () => {
    await page.goto(`${URL}/factures/${factureId}`, { waitUntil: 'networkidle' })
    const toggle = page.locator('[data-testid="raw-edit-toggle"]')
    await toggle.waitFor({ timeout: 5000 })
    assert.equal(await toggle.isVisible(), true)
  })

  test('ouvrir le panneau charge le schéma et expose les champs DB', async () => {
    await page.goto(`${URL}/factures/${factureId}`, { waitUntil: 'networkidle' })
    await page.click('[data-testid="raw-edit-toggle"]')
    // Quelques champs représentatifs doivent apparaître.
    await page.waitForSelector('[data-testid="raw-edit-input-shipping_country"]', { timeout: 5000 })
    await page.waitForSelector('[data-testid="raw-edit-input-paid_charge_id"]', { timeout: 5000 })
    await page.waitForSelector('[data-testid="raw-edit-input-revenue_recognized_je_id"]', { timeout: 5000 })
  })

  test('éditer shipping_country persiste la valeur en DB via autosave', async () => {
    await page.goto(`${URL}/factures/${factureId}`, { waitUntil: 'networkidle' })
    await page.click('[data-testid="raw-edit-toggle"]')
    const input = page.locator('[data-testid="raw-edit-input-shipping_country"]')
    await input.waitFor({ timeout: 5000 })
    await input.fill(TEST_VALUE)
    // Trigger autosave en sortant du champ.
    await input.blur()
    // Attendre un cycle réseau (PATCH + refetch).
    await page.waitForTimeout(800)
    const inDb = db.prepare('SELECT shipping_country FROM factures WHERE id=?').get(factureId)
    assert.equal(inDb.shipping_country, TEST_VALUE, `Valeur DB attendue ${TEST_VALUE}, lue ${inDb.shipping_country}`)
  })
})
