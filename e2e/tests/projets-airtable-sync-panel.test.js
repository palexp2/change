const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Page Projets — panneau de sync Airtable déplacé en haut', () => {
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

  test('bouton "Sync Airtable" présent dans le header — ouvre une modale avec les sélecteurs', async () => {
    await page.goto(`${URL}/pipeline`, { waitUntil: 'networkidle' })

    const trigger = page.locator('button:has-text("Sync Airtable")').first()
    await trigger.waitFor({ state: 'visible', timeout: 5000 })
    assert.ok(await trigger.isVisible(), 'bouton "Sync Airtable" absent du header')

    // Avant clic : pas de modale, donc pas de sélecteur Base Airtable visible
    const baseLabel = page.locator('label:has-text("Base Airtable")').first()
    assert.equal(await baseLabel.isVisible().catch(() => false), false, 'modale ne devrait pas être ouverte par défaut')

    // Clic → modale s'ouvre
    await trigger.click()

    // La modale a un titre "Synchronisation Airtable"
    const modalTitle = page.locator('h2:has-text("Synchronisation Airtable")').first()
    await modalTitle.waitFor({ state: 'visible', timeout: 3000 })
    assert.ok(await modalTitle.isVisible(), 'titre de modale absent')

    // Sélecteurs et bouton sync présents dans la modale
    await baseLabel.waitFor({ state: 'visible', timeout: 3000 })
    const tableLabel = page.locator('label:has-text("Table projets")').first()
    await tableLabel.waitFor({ state: 'visible', timeout: 3000 })
    const syncBtn = page.locator('button:has-text("Synchroniser maintenant")').first()
    await syncBtn.waitFor({ state: 'visible', timeout: 3000 })
    assert.ok(await syncBtn.isVisible(), 'bouton "Synchroniser maintenant" absent dans la modale')

    // Liste des champs de la table projects (DB) — quelques colonnes attendues
    const fieldsHeader = page.locator('text=Champs de la table').first()
    await fieldsHeader.waitFor({ state: 'visible', timeout: 5000 })
    for (const col of ['name', 'status', 'probability', 'value_cad', 'company_id', 'close_date']) {
      const cell = page.locator(`text=/^${col}$/`).first()
      await cell.waitFor({ state: 'visible', timeout: 5000 })
      assert.ok(await cell.isVisible(), `colonne "${col}" attendue dans la liste des champs`)
    }
  })

  test('cocher/décocher un champ le gèle/dégèle côté API (Airtable ne l\'écrasera plus)', async () => {
    await page.goto(`${URL}/pipeline`, { waitUntil: 'networkidle' })
    await page.locator('button:has-text("Sync Airtable")').first().click()

    // Trouver la ligne pour la colonne "notes"
    const row = page.locator('label', { has: page.locator('text=/^notes$/') }).first()
    await row.waitFor({ state: 'visible', timeout: 5000 })
    const checkbox = row.locator('input[type="checkbox"]')

    // État de départ : coché (synchronisé). Décoche pour geler.
    const wasChecked = await checkbox.isChecked()
    if (!wasChecked) {
      // état incohérent, on remet à coché via l'API avant de tester
      await checkbox.check()
    }
    assert.equal(await checkbox.isChecked(), true, 'la case "notes" devrait être cochée au départ')

    // Intercepter la requête PUT
    const [req] = await Promise.all([
      page.waitForRequest(r => r.url().includes('/api/connectors/frozen-columns/projects') && r.method() === 'PUT', { timeout: 5000 }),
      checkbox.uncheck(),
    ])
    const body = JSON.parse(req.postData() || '{}')
    assert.equal(body.column_name, 'notes', 'column_name attendu = notes')
    assert.equal(body.frozen, true, 'frozen attendu = true')

    // La case reste décochée (optimistic + succès)
    assert.equal(await checkbox.isChecked(), false, 'la case "notes" devrait être décochée après gel')

    // Re-coche → dégèle
    const [req2] = await Promise.all([
      page.waitForRequest(r => r.url().includes('/api/connectors/frozen-columns/projects') && r.method() === 'PUT', { timeout: 5000 }),
      checkbox.check(),
    ])
    const body2 = JSON.parse(req2.postData() || '{}')
    assert.equal(body2.frozen, false, 'frozen attendu = false au re-toggle')
    assert.equal(await checkbox.isChecked(), true, 'la case "notes" devrait être recochée')
  })

  test('onglet "Projets" retiré de la section Airtable des connecteurs', async () => {
    await page.goto(`${URL}/connectors`, { waitUntil: 'networkidle' })

    // Open Airtable card
    await page.locator('button:has-text("Airtable")').first().click()

    // Wait for the tabs row
    await page.locator('button:has-text("Contacts")').first().waitFor({ state: 'visible', timeout: 5000 })

    // The "Projets" tab inside the Airtable connector should be gone.
    // Other "Projets" matches (sidebar nav, etc.) might still exist, so we
    // scope to the Airtable card body.
    const airtableSection = page.locator('div.card', { has: page.locator('button:has-text("Airtable")') }).first()
    const projetsTab = airtableSection.locator('button:has-text("Projets")')
    const count = await projetsTab.count()
    assert.equal(count, 0, `onglet "Projets" toujours présent dans Airtable (${count})`)
  })
})
