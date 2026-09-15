const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// /champs/tickets — un champ FORMULE d'Airtable n'offre pas le choix du sens.
//
// Signalement : Boréal proposait « Bidirectionnel » sur des champs dont la
// valeur est calculée par Airtable. Airtable rejette tout PATCH sur ces
// champs-là (422) : le réglage ne pouvait mener qu'à des écritures perdues.
//
// Cas réel de la table des billets : la colonne `cf_billet` est alimentée par
// le champ Airtable « ID », qui est une formule. Sa flèche de sens doit être
// une icône figée en import (pas un bouton ouvrant le menu pull/push/both),
// tandis qu'un champ ordinaire de la même page garde son bouton.
//
// Lecture seule : aucun mapping n'est modifié, aucun record touché.
describe('/champs/tickets — pas de bidirectionnel sur une formule Airtable', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    // Les métadonnées Airtable arrivent en asynchrone — sans elles, le type du
    // champ visé est inconnu et le sens s'afficherait encore réglable. On attend
    // donc la réponse de /mapping-data, pas seulement le rendu du tableau.
    const mapping = page.waitForResponse(
      r => r.url().includes('/mapping-data') && r.status() === 200,
      { timeout: 60000 }
    )
    await page.goto(URL + '/champs/tickets', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="fieldcfg-row-cf_billet"]', { timeout: 30000 })
    await mapping
  })

  after(async () => { await browser?.close() })

  test('le champ alimenté par une formule Airtable est verrouillé en import', async () => {
    const dir = page.locator('[data-testid="fieldcfg-direction-cf_billet"]')
    await dir.waitFor({ state: 'visible', timeout: 15000 })
    assert.equal(await dir.getAttribute('data-direction'), 'pull')
    // Icône figée, pas un bouton : le menu pull/push/both ne doit pas exister.
    assert.equal(await dir.evaluate(el => el.tagName.toLowerCase()), 'span')
    assert.match(await dir.getAttribute('title'), /calcul|formule/i)
  })

  test('un champ Airtable ordinaire garde son sélecteur de sens', async () => {
    // « Titre » est un texte simple : rien n'empêche de le réécrire vers Airtable.
    const dir = page.locator('[data-testid="coremap-billets-dyn-titre-direction"]')
    await dir.waitFor({ state: 'visible', timeout: 15000 })
    assert.equal(await dir.evaluate(el => el.tagName.toLowerCase()), 'button')
    await dir.click()
    const menu = page.locator('[data-testid="coremap-billets-dyn-titre-direction-menu"]')
    await menu.waitFor({ state: 'visible', timeout: 5000 })
    assert.ok(await menu.locator('text=Bidirectionnel').count() > 0)
    // Referme sans rien changer.
    await page.keyboard.press('Escape')
    await page.mouse.click(5, 5)
  })
})
