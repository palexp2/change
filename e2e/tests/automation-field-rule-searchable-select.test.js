// AutomationDetail (FieldRuleTriggerEditor) — les <select> natifs « Table ERP »
// (~20 tables) et « Colonne » ont été remplacés par le composant SearchableSelect
// (règle de design CLAUDE.md « dropdowns avec recherche » : tout dropdown >10
// options doit être filtrable).
//
// On ouvre l'éditeur de règle de champ via /automations/new?kind=field_rule —
// ce mode prépare un triggerConfig (erp_table='tickets') SANS créer de record en
// DB (l'autosave est désactivé tant que isNew, la création passe par le bouton
// « Créer » qu'on ne clique jamais). Donc aucun cleanup DB nécessaire.
//
// Vérifie que :
//   1. « Table ERP » et « Colonne » sont des <button> (testId) et non des <select>.
//   2. Ouvrir « Table ERP » affiche un menu en portail avec champ de recherche.
//   3. Taper filtre les options en direct (et « Aucun résultat » si rien ne matche).
//   4. Choisir une table referme le menu et reflète le libellé dans le bouton.
//   5. « Colonne » est aussi un SearchableSelect filtrable.

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

describe('AutomationDetail — SearchableSelect Table ERP / Colonne', () => {
  let browser, ctx, page
  let tables = []

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await login(page)

    const res = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/automations/field-rule/tables', { headers: { Authorization: `Bearer ${tok}` } })
      return { status: r.status, body: await r.json() }
    })
    assert.equal(res.status, 200, 'liste des tables de règle inaccessible')
    assert.ok(Array.isArray(res.body) && res.body.length > 10, 'la liste des tables ERP devrait dépasser 10 (sinon la règle ne s\'applique pas)')
    tables = res.body
  })

  after(async () => {
    await browser?.close()
  })

  test('Table ERP et Colonne sont des SearchableSelect filtrables', async () => {
    await page.goto(`${URL}/automations/new?kind=field_rule`, { waitUntil: 'networkidle' })

    // 1. Les deux déclencheurs existent comme <button> (pas <select> natif).
    const tableSel = page.locator('[data-testid="automation-erp-table"]')
    const colSel = page.locator('[data-testid="automation-column"]')
    await tableSel.waitFor({ state: 'visible', timeout: 10000 })
    await colSel.waitFor({ state: 'visible', timeout: 10000 })
    assert.equal(await tableSel.evaluate(el => el.tagName.toLowerCase()), 'button', '« Table ERP » doit être un bouton')
    assert.equal(await colSel.evaluate(el => el.tagName.toLowerCase()), 'button', '« Colonne » doit être un bouton')

    // 2. Ouvrir « Table ERP » → champ de recherche présent.
    await tableSel.click()
    const tableMenu = page.locator('[data-testid="automation-erp-table-menu"]')
    await tableMenu.waitFor({ state: 'visible', timeout: 5000 })
    const searchInput = tableMenu.locator('input')
    await searchInput.waitFor({ state: 'visible' })

    const optionSelector = '[data-testid="automation-erp-table-menu"] > div:last-child > button'
    const totalOptions = await page.locator(optionSelector).count()
    assert.ok(totalOptions > 10, 'le menu devrait lister >10 tables')

    // 3. Filtrer sur un fragment du nom d'une table.
    const target = tables.find(t => t.length >= 3) || tables[0]
    const frag = target.slice(0, 3)
    await searchInput.fill(frag)
    await page.waitForTimeout(250)
    const filteredCount = await page.locator(optionSelector).count()
    assert.ok(filteredCount >= 1, `le filtre "${frag}" devrait laisser au moins une table`)
    assert.ok(filteredCount <= totalOptions, 'le filtre ne devrait pas augmenter le nombre d\'options')

    // Filtre sans résultat → « Aucun résultat ».
    await searchInput.fill('zzz-aucune-table-xyz-9999')
    await page.waitForTimeout(250)
    await tableMenu.locator('text=Aucun résultat').waitFor({ state: 'visible', timeout: 3000 })

    // 4. Re-filtrer puis sélectionner → menu fermé + libellé reflété.
    await searchInput.fill(frag)
    await page.waitForTimeout(250)
    const opt = page.locator(optionSelector).first()
    const chosen = (await opt.innerText()).trim()
    await opt.click()
    await tableMenu.waitFor({ state: 'hidden', timeout: 5000 })
    const btnText = (await tableSel.innerText()).trim()
    assert.ok(btnText.length > 0 && !btnText.includes('choisir'), '« Table ERP » devrait afficher la table choisie')
    assert.ok(chosen.includes(btnText) || btnText.includes(chosen), 'le libellé du bouton devrait correspondre à la table sélectionnée')

    // 5. « Colonne » est aussi un SearchableSelect : ouvrir → champ de recherche.
    await colSel.click()
    const colMenu = page.locator('[data-testid="automation-column-menu"]')
    await colMenu.waitFor({ state: 'visible', timeout: 5000 })
    await colMenu.locator('input').waitFor({ state: 'visible' })
    // Refermer en cliquant sur le label (Escape pourrait remonter et fermer la page).
    await page.locator('label:has-text("Colonne")').click()
    await colMenu.waitFor({ state: 'hidden', timeout: 5000 })

    // Aucun record créé (on ne clique jamais « Créer ») → pas de cleanup DB.
  })
})
