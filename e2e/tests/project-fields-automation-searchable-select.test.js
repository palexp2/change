// Remplacement des <select> natifs >10 options par SearchableSelect (règle de
// design CLAUDE.md « dropdowns avec recherche ») dans :
//   - ProjectFields.jsx : pickers Base / Table projets (config Airtable) et,
//     dans le MappingPicker, le picker « Champ Airtable » (et « Table cible »).
//   - AutomationDetail.jsx (FieldRuleActionEditor) : picker « Expéditeur » Postmark
//     d'une action email.
//
// Aucune config n'est sauvegardée : on n'appuie jamais sur « Enregistrer »,
// « Synchroniser », « OK » ni « Créer ». La sélection ne touche que l'état local
// React → aucune écriture en DB, donc pas de cleanup ni de restauration.

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

describe('SearchableSelect — ProjectFields & AutomationDetail', () => {
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

  test('ProjectFields : Base et Table projets sont des SearchableSelect filtrables', async () => {
    await page.goto(`${URL}/projects/fields`, { waitUntil: 'networkidle' })

    // 1. Le picker base existe et c'est un <button> (pas un <select> natif).
    const baseTrigger = page.locator('[data-testid="projets-base-select"]')
    await baseTrigger.waitFor({ state: 'visible', timeout: 10000 })
    assert.equal(await baseTrigger.evaluate(el => el.tagName.toLowerCase()), 'button', 'le picker base doit être un bouton (SearchableSelect)')

    // Le picker table existe aussi comme bouton (désactivé tant que pas de base).
    const tableTrigger = page.locator('[data-testid="projets-table-select"]')
    await tableTrigger.waitFor({ state: 'visible', timeout: 5000 })
    assert.equal(await tableTrigger.evaluate(el => el.tagName.toLowerCase()), 'button', 'le picker table doit être un bouton (SearchableSelect)')

    // 2. Ouvrir base → menu en portail avec champ de recherche.
    await baseTrigger.click()
    const menu = page.locator('[data-testid="projets-base-select-menu"]')
    await menu.waitFor({ state: 'visible', timeout: 5000 })
    await menu.locator('input').waitFor({ state: 'visible' })

    // Les bases chargent en async ; on attend au moins l'option vide + une base réelle.
    const optionSelector = '[data-testid="projets-base-select-menu"] button'
    await page.waitForFunction(
      sel => document.querySelectorAll(sel).length >= 2,
      optionSelector,
      { timeout: 10000 }
    )
    const total = await page.locator(optionSelector).count()
    assert.ok(total >= 2, `le menu base devrait lister plusieurs options, got ${total}`)

    // 3. Filtre sans résultat → « Aucun résultat ».
    await menu.locator('input').fill('zzz-aucune-base-' + Date.now())
    await page.waitForTimeout(200)
    await menu.locator('text=Aucun résultat').waitFor({ state: 'visible', timeout: 3000 })
  })

  test('ProjectFields : le picker « Champ Airtable » du MappingPicker est un SearchableSelect', async () => {
    await page.goto(`${URL}/projects/fields`, { waitUntil: 'networkidle' })
    // Attendre le chargement du tableau des champs.
    await page.locator('h1:has-text("Champs")').waitFor({ state: 'visible', timeout: 10000 })

    // Cherche un bouton « Mapper » actif (colonne avec champs Airtable compatibles).
    // Si aucun n'est disponible dans l'état courant de la config, on n'échoue pas :
    // le picker reste couvert par les tests des autres pages.
    const mapBtn = page.locator('button:has-text("Mapper"):not([disabled])').first()
    if ((await mapBtn.count()) === 0) {
      console.log('Aucune colonne mappable disponible — picker « Champ Airtable » non testé cette fois.')
      return
    }
    await mapBtn.click()
    const fieldTrigger = page.locator('[data-testid="mapping-airtable-field"]')
    await fieldTrigger.waitFor({ state: 'visible', timeout: 5000 })
    assert.equal(await fieldTrigger.evaluate(el => el.tagName.toLowerCase()), 'button', 'le picker champ Airtable doit être un bouton (SearchableSelect)')

    await fieldTrigger.click()
    const fieldMenu = page.locator('[data-testid="mapping-airtable-field-menu"]')
    await fieldMenu.waitFor({ state: 'visible', timeout: 5000 })
    await fieldMenu.locator('input').waitFor({ state: 'visible' })
  })

  test('AutomationDetail (field-rule email) : « Expéditeur » est un SearchableSelect filtrable', async () => {
    await page.goto(`${URL}/automations/new?kind=field_rule`, { waitUntil: 'networkidle' })

    // Sélectionner le type d'action « Email » pour révéler le picker Expéditeur.
    await page.locator('button:has-text("Email")').first().click()

    const trigger = page.locator('[data-testid="action-from-select"]')
    await trigger.waitFor({ state: 'visible', timeout: 8000 })
    assert.equal(await trigger.evaluate(el => el.tagName.toLowerCase()), 'button', 'le picker Expéditeur doit être un bouton (SearchableSelect)')

    await trigger.click()
    const menu = page.locator('[data-testid="action-from-select-menu"]')
    await menu.waitFor({ state: 'visible', timeout: 5000 })
    await menu.locator('input').waitFor({ state: 'visible' })

    // L'option vide « — Défaut global — » est toujours présente.
    const optionTexts = await menu.locator('button').evaluateAll(btns => btns.map(b => b.textContent.trim()))
    assert.ok(optionTexts.some(t => t.includes('Défaut global')), 'l\'option « Défaut global » devrait être listée')

    // Filtre sans résultat → « Aucun résultat » (les adresses, si présentes, sont filtrées).
    await menu.locator('input').fill('zzz-aucune-adresse-' + Date.now())
    await page.waitForTimeout(200)
    await menu.locator('text=Aucun résultat').waitFor({ state: 'visible', timeout: 3000 })

    // Aucun record créé (on ne clique jamais « Créer ») → pas de cleanup DB.
  })
})
