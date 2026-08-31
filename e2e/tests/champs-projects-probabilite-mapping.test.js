const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// /champs/projects — les colonnes NATIVES doivent être mappables depuis Airtable.
//
// Régression corrigée : le serveur ne connaissait pas le type déclaré d'une
// colonne native (Probabilité = nombre, Date de clôture = date…) et la donnait
// pour du texte. Le picker de mapping ne filtrait alors que des champs Airtable
// texte → « Aucun champ compat. », bouton désactivé : impossible de mapper
// « Probabilité ». En prime, la def native de Probabilité EST appariée par nom
// au vrai champ Airtable par le sync (elle importe la valeur), ce que la page
// affichait comme « non mappé ».
//
// Lecture seule : aucun mapping n'est enregistré (le picker est ouvert puis
// annulé), aucun record ni configuration touchés.
describe('/champs/projects — mapping Airtable des champs natifs', () => {
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

    await page.goto(URL + '/champs/projects', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="fieldcfg-row-probability"]', { timeout: 20000 })
    // Les métadonnées Airtable arrivent en asynchrone : tant qu'elles ne sont
    // pas là, aucune cellule « Champ Airtable » n'est peuplée.
    await page.waitForSelector('text=/mappé.? depuis Airtable/', { timeout: 30000 })
  })

  after(async () => { await browser?.close() })

  test('Probabilité affiche le champ Airtable qui l’alimente', async () => {
    const cell = page.locator('[data-testid="fieldcfg-airtable-probability"]')
    await cell.waitFor({ state: 'visible', timeout: 15000 })

    const txt = (await cell.innerText()).trim()
    assert.ok(
      !/Aucun champ compat/i.test(txt),
      `le champ Probabilité doit être mappable (cellule : « ${txt} »)`
    )
    assert.match(txt, /Probabilité/, `le mapping Airtable de Probabilité doit être affiché (cellule : « ${txt} »)`)

    // Sens de sync affiché comme importé (Airtable → ERP), pas « aucun mapping ».
    const dir = page.locator('[data-testid="fieldcfg-direction-probability"]')
    assert.equal(await dir.getAttribute('data-direction'), 'pull')
  })

  test('une colonne native non mappée propose des champs Airtable compatibles', async () => {
    // « Mensuel (CAD) » est un nombre : avant le correctif il passait pour du
    // texte et le bouton « Mapper » était désactivé faute de candidat.
    const cell = page.locator('[data-testid="fieldcfg-airtable-monthly_cad"]')
    await cell.waitFor({ state: 'visible', timeout: 15000 })
    const btn = cell.locator('button')
    const label = (await btn.innerText()).trim()
    assert.ok(!/Aucun champ compat/i.test(label), `« Mensuel (CAD) » doit être mappable (bouton : « ${label} »)`)
    assert.ok(await btn.isEnabled(), 'le bouton « Mapper » doit être actif')

    // Ouvre le picker : il doit lister au moins un champ Airtable candidat.
    await btn.click()
    const select = cell.locator('[data-testid="mapping-airtable-field"]')
    await select.waitFor({ state: 'visible', timeout: 5000 })
    await select.click()
    // Le menu est rendu en portail (hors de la cellule).
    const menu = page.locator('[data-testid="mapping-airtable-field-menu"]')
    await menu.waitFor({ state: 'visible', timeout: 5000 })
    assert.equal(await menu.locator('text=Aucun résultat').count(), 0, 'le picker doit proposer des champs Airtable numériques')
    // 1er bouton = l'option vide « — Champ Airtable — » : il en faut d'autres.
    assert.ok(await menu.locator('button').count() > 1, 'le picker doit proposer des champs Airtable numériques')

    // Referme sans rien enregistrer.
    await page.keyboard.press('Escape')
    const cancel = cell.locator('button:has-text("Annuler")')
    if (await cancel.count()) await cancel.click()
    assert.equal(await cell.locator('[data-testid="mapping-airtable-field"]').count(), 0, 'le picker doit être refermé')
  })
})
