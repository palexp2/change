const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Bouton « Configurer les champs » de la barre d'outils de chaque DataTable →
// page pleine page /champs/:table (FieldConfig.jsx) : renommage inline,
// suppression des champs perso, et onglets de mapping Airtable — qui
// remplacent l'ancien bouton « Sync Airtable » ouvert page par page.
//
// Lecture seule : aucune configuration n'est enregistrée (aucun renommage
// validé), aucun record touché.
describe('Page de configuration des champs', () => {
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
  })

  after(async () => { await browser?.close() })

  async function open(path) {
    await page.goto(URL + path, { waitUntil: 'domcontentloaded' })
    const btn = page.locator('button:has-text("Configurer les champs")')
    await btn.first().waitFor({ state: 'visible', timeout: 20000 })
    await btn.first().click()
    await page.waitForURL(u => /\/champs\//.test(u.toString()), { timeout: 15000 })
    // La barre d'onglets est masquée quand il n'y a que « Champs » : on attend
    // le tableau lui-même.
    await page.waitForSelector('[data-testid^="fieldcfg-row-"]', { timeout: 20000 })
  }

  test('/orders : la page liste les champs (nom éditable) et les onglets Airtable', async () => {
    await open('/orders')

    const rows = page.locator('[data-testid^="fieldcfg-row-"]')
    assert.ok(await rows.count() > 3, 'la liste des champs doit être peuplée')

    // Le nom de chaque champ est éditable (le réordonnancement, lui, a été retiré).
    const first = rows.first()
    const nameInput = first.locator('input')
    await nameInput.waitFor({ timeout: 5000 })
    assert.ok((await nameInput.inputValue()).length > 0, 'le nom du champ est éditable')

    // Le module des commandes est entièrement fusionné dans le tableau (ses clés
    // de mapping cœur déclarent leur colonne ERP) : plus d'onglet dédié. Celui
    // des lignes de commande reste — il alimente une autre table ERP.
    await page.waitForSelector('[data-testid="fieldcfg-tab-order_items"]', { timeout: 15000 })
    assert.equal(await page.locator('[data-testid="fieldcfg-tab-orders"]').count(), 0)
    await page.click('[data-testid="fieldcfg-tab-order_items"]')
    // Le panneau de mapping cœur (inchangé) s'affiche dans l'onglet.
    await page.waitForSelector('[data-testid="coremap-order_items-headers"]', { timeout: 20000 })
    await page.click('[data-testid="fieldcfg-tab-fields"]')

    // Retour à la table d'où l'on vient.
    await page.click('[data-testid="fieldcfg-back"]')
    await page.waitForURL(u => u.toString().includes('/orders'), { timeout: 15000 })
  })

  test("l'ancien bouton « Sync Airtable » a disparu des en-têtes de page", async () => {
    for (const path of ['/orders', '/products', '/factures', '/paies']) {
      await page.goto(URL + path, { waitUntil: 'domcontentloaded' })
      await page.locator('button:has-text("Configurer les champs")').first()
        .waitFor({ state: 'visible', timeout: 20000 })
      assert.equal(
        await page.locator('button:has-text("Sync Airtable")').count(), 0,
        `${path} : plus aucun bouton « Sync Airtable » dans l'en-tête`
      )
    }
  })

  test('/tickets : le mapping Airtable est fusionné dans le tableau des champs', async () => {
    await open('/tickets')
    assert.ok(await page.locator('[data-testid^="fieldcfg-row-"]').count() > 3)
    // Module sans mapping cœur : pas d'onglet séparé, tout est dans le tableau.
    assert.equal(await page.locator('[data-testid="fieldcfg-tab-billets"]').count(), 0)
    // Bandeau de source + colonne « Champ Airtable » sur chaque ligne (le
    // mapping-data met quelques secondes : métadonnées Airtable).
    await page.waitForSelector('h2:has-text("Source Airtable")', { timeout: 20000 })
    await page.waitForSelector('[data-testid^="fieldcfg-airtable-"]', { timeout: 30000 })
    const rows = await page.locator('[data-testid^="fieldcfg-row-"]').count()
    const atCells = await page.locator('[data-testid^="fieldcfg-airtable-"]').count()
    assert.equal(atCells, rows, 'chaque ligne porte sa cellule de mapping Airtable')
  })

  test('/champs/contacts : un seul tableau, la barre d\'onglets disparaît', async () => {
    await page.goto(URL + '/champs/contacts', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid^="fieldcfg-row-"]', { timeout: 20000 })
    // Un seul onglet (« Champs ») → la barre est masquée.
    assert.equal(await page.locator('[data-testid^="fieldcfg-tab-"]').count(), 1)
    assert.ok(!(await page.locator('[data-testid="fieldcfg-tab-fields"]').isVisible()))
    // La recherche filtre le tableau fusionné.
    await page.waitForSelector('[data-testid^="fieldcfg-airtable-"]', { timeout: 30000 })
    const before = await page.locator('[data-testid^="fieldcfg-row-"]').count()
    await page.fill('[data-testid="fieldcfg-search"]', 'courriel')
    const after = await page.locator('[data-testid^="fieldcfg-row-"]').count()
    assert.ok(after > 0 && after < before, `la recherche doit réduire la liste (${before} → ${after})`)
  })

  test('une page sans module Airtable n’affiche que l’onglet Champs', async () => {
    await open('/tasks')
    assert.equal(await page.locator('[data-testid^="fieldcfg-tab-"]').count(), 1)
  })
})
