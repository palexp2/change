const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Connecteur Airtable — détail des champs supprimé', () => {
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

  test('aucun bloc "X champs" affiché dans la section Airtable', async () => {
    await page.goto(`${URL}/connectors`, { waitUntil: 'networkidle' })

    // Open Airtable card
    const airtableCard = page.locator('button:has-text("Airtable")').first()
    await airtableCard.click()

    // Wait for the tabs row (a configured tab has a green dot indicator)
    await page.locator('button:has-text("Contacts")').first().waitFor({ state: 'visible', timeout: 5000 })

    // Iterate through all configured tabs and confirm no "champs" detail block appears
    const tabs = ['Contacts', 'Entreprises', 'Adresses', 'Projets', 'Soumissions', 'Pièces',
      'N° de série', 'BOM', 'Assemblages', 'Commandes', 'Achats', 'Envois', 'Billets',
      'Retours', 'Items de retour']

    for (const label of tabs) {
      const tabBtn = page.locator(`button:has-text("${label}")`).first()
      if (!(await tabBtn.isVisible().catch(() => false))) continue
      await tabBtn.click()
      // Wait for tab content (Base Airtable label)
      await page.locator('label:has-text("Base Airtable")').first().waitFor({ state: 'visible', timeout: 3000 })

      // The removed block has the heading like "12 champs" — verify it's absent
      const champsHeading = page.locator('text=/^\\d+ champs$/')
      const count = await champsHeading.count()
      assert.equal(count, 0, `bloc "N champs" présent dans l'onglet "${label}" (${count} occurrences)`)
    }
  })
})
