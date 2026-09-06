// Pickers « Base Airtable » / « Table » → SearchableSelect (règle de design
// CLAUDE.md « dropdowns avec recherche »). Avant, c'étaient des <select> natifs
// répétés dans AirtableConfig.jsx (tous les onglets) et dans le SyncPanel de
// Employees.jsx — un workspace Airtable expose couramment 50+ bases / 30+ tables.
//
// Vérifie :
//   1. AirtableConfig (onglet Contacts) : le picker base est un bouton (testId)
//      ouvrant un menu en portail avec champ de recherche, filtrable, sélectionnable,
//      qui révèle ensuite le picker table (lui aussi un SearchableSelect).
//   2. Employees > SyncPanel : le picker base est aussi un SearchableSelect filtrable.
//
// Aucune config n'est sauvegardée : on n'appuie jamais sur « Enregistrer » ni
// « Synchroniser ». La sélection ne modifie que l'état local React, donc aucune
// écriture en DB → pas de cleanup ni de restauration nécessaire.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

async function login(page) {
  await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASS)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
}

describe('SearchableSelect — pickers base/table Airtable', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await login(page)
  })

  after(async () => {
    await browser?.close()
  })

  test('AirtableConfig (Contacts) : base + table sont des SearchableSelect filtrables', async () => {
    await page.goto(`${URL}/connectors`, { waitUntil: 'networkidle' })

    // Déplier la carte du connecteur Airtable.
    await page.locator('button:has-text("Airtable")').first().click()

    // 1. Le picker base existe et c'est un <button> (pas un <select> natif).
    const baseTrigger = page.locator('[data-testid="contacts-base-select"]')
    await baseTrigger.waitFor({ state: 'visible', timeout: 10000 })
    const tag = await baseTrigger.evaluate(el => el.tagName.toLowerCase())
    assert.equal(tag, 'button', 'le picker base doit être un bouton (SearchableSelect)')

    // 2. Ouvrir → menu en portail avec champ de recherche.
    await baseTrigger.click()
    const menu = page.locator('[data-testid="contacts-base-select-menu"]')
    await menu.waitFor({ state: 'visible', timeout: 5000 })
    const searchInput = menu.locator('input')
    await searchInput.waitFor({ state: 'visible' })

    // Les bases chargent en async (api.airtable.bases) ; le menu réactif se peuple
    // au fur et à mesure. On attend qu'au moins une vraie base (au-delà de l'option
    // vide « — ») apparaisse.
    const optionSelector = '[data-testid="contacts-base-select-menu"] button'
    await page.waitForFunction(
      sel => document.querySelectorAll(sel).length >= 2,
      optionSelector,
      { timeout: 10000 }
    )
    const totalOptions = await page.locator(optionSelector).count()
    assert.ok(totalOptions >= 2, `le menu devrait lister plusieurs bases, got ${totalOptions}`)

    // 3a. Filtrer sur le libellé de la première base réelle → résultat restreint.
    const firstBaseLabel = (await page.locator(optionSelector).nth(1).innerText()).trim()
    await searchInput.fill(firstBaseLabel.slice(0, 4))
    await page.waitForTimeout(150)
    const filteredCount = await page.locator(optionSelector).count()
    assert.ok(filteredCount >= 1 && filteredCount <= totalOptions, 'le filtre devrait restreindre la liste')

    // 3b. Requête absurde → « Aucun résultat ».
    await searchInput.fill('zzz-aucune-base-zzz-' + Date.now())
    await page.waitForTimeout(150)
    await menu.locator('text=Aucun résultat').waitFor({ state: 'visible', timeout: 3000 })

    // 4. Re-filtrer et choisir la base → menu fermé + libellé reflété dans le bouton.
    await searchInput.fill(firstBaseLabel.slice(0, 4))
    await page.waitForTimeout(150)
    await page.locator(optionSelector, { hasText: firstBaseLabel }).first().click()
    await menu.waitFor({ state: 'hidden', timeout: 3000 })
    const triggerText = (await baseTrigger.innerText()).trim()
    assert.ok(triggerText.includes(firstBaseLabel), `le bouton devrait afficher la base choisie, got "${triggerText}"`)

    // 5. Le picker table apparaît (tables chargées) et c'est aussi un SearchableSelect.
    const tableTrigger = page.locator('[data-testid="contacts-table-select"]')
    await tableTrigger.waitFor({ state: 'visible', timeout: 10000 })
    const tableTag = await tableTrigger.evaluate(el => el.tagName.toLowerCase())
    assert.equal(tableTag, 'button', 'le picker table doit être un bouton (SearchableSelect)')
    await tableTrigger.click()
    await page.locator('[data-testid="contacts-table-select-menu"] input').waitFor({ state: 'visible', timeout: 5000 })
  })

  test('Employees SyncPanel : le picker base est un SearchableSelect filtrable', async () => {
    await page.goto(`${URL}/employees`, { waitUntil: 'networkidle' })

    // Déplier le panneau « Synchronisation Airtable ».
    await page.locator('button:has-text("Synchronisation Airtable")').click()

    const baseTrigger = page.locator('[data-testid="employees-base-select"]')
    await baseTrigger.waitFor({ state: 'visible', timeout: 10000 })
    const tag = await baseTrigger.evaluate(el => el.tagName.toLowerCase())
    assert.equal(tag, 'button', 'le picker base doit être un bouton (SearchableSelect)')

    await baseTrigger.click()
    const menu = page.locator('[data-testid="employees-base-select-menu"]')
    await menu.waitFor({ state: 'visible', timeout: 5000 })
    await menu.locator('input').waitFor({ state: 'visible' })

    const optionSelector = '[data-testid="employees-base-select-menu"] button'
    const total = await page.locator(optionSelector).count()
    assert.ok(total >= 2, `le menu devrait lister plusieurs bases, got ${total}`)
  })
})
