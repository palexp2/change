// Vérifie la fonctionnalité « descriptions/tooltips de colonnes » :
// - une colonne dotée d'un champ `description` dans tableDefs.js affiche une
//   icône « ? » (data-testid="datatable-col-help") dans son en-tête de DataTable
// - au survol de l'icône, une infobulle (role="tooltip") apparaît avec le texte
//   de description
//
// Test 100% lecture seule : aucune création de record, aucune config écrasée.
// Cible la page Entreprises, dont la colonne « Contacts » (contacts_count) est
// visible par défaut et porte une description.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('DataTable — infobulles de description de colonne', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
  })

  after(async () => { await browser?.close() })

  test('l\'icône « ? » de l\'en-tête affiche une infobulle au survol', async () => {
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    await page.goto(`${URL}/companies`, { waitUntil: 'networkidle' })
    await page.waitForSelector('text=/\\d+\\s+lignes?/', { timeout: 10000 })

    // Au moins une icône d'aide doit être présente dans les en-têtes.
    const help = page.locator('[data-testid="datatable-col-help"]').first()
    await help.waitFor({ state: 'visible', timeout: 5000 })

    // Aucune infobulle visible avant le survol.
    assert.equal(await page.locator('[role="tooltip"]').count(), 0,
      'aucune infobulle ne doit être affichée au repos')

    // Survol → l'infobulle apparaît avec du texte.
    await help.hover()
    const tip = page.locator('[role="tooltip"]').first()
    await tip.waitFor({ state: 'visible', timeout: 3000 })
    const txt = (await tip.textContent() || '').trim()
    assert.ok(txt.length > 0, 'l\'infobulle doit contenir du texte de description')

    // Sortie du survol → l'infobulle disparaît.
    await page.mouse.move(10, 10)
    await tip.waitFor({ state: 'hidden', timeout: 3000 })
  })

  test('la colonne « Contacts » expose sa description via aria-label', async () => {
    // Le contenu de la description du flag est rendu dans l'aria-label de
    // l'icône — on vérifie qu'au moins une icône d'aide porte une description
    // non vide (couvre le câblage tableDefs.description → ColumnHelp).
    const labels = await page.locator('[data-testid="datatable-col-help"]').evaluateAll(
      els => els.map(e => e.getAttribute('aria-label') || '')
    )
    assert.ok(labels.length > 0, 'au moins une icône d\'aide attendue')
    assert.ok(labels.some(l => l.trim().length > 10),
      'au moins une icône doit exposer une description significative')
  })
})
