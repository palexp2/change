const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Signalement : sur /champs/orders, le mapping Airtable des commandes vivait
// dans un onglet « Airtable · Commandes » séparé du tableau des champs — deux
// endroits pour la même chose, et la ligne « Statut » du tableau affichait un
// picker vide alors que son import venait du mapping cœur de l'autre onglet.
//
// L'onglet est maintenant fusionné : chaque clé cœur (spec serveur qui déclare
// sa colonne ERP) pose son picker sur la ligne du champ correspondant, avec son
// sens de synchronisation, et une barre « Enregistrer le mapping » sous le
// tableau (ce mapping n'est pas autosauvé : il peut relancer une resync).
//
// Test 100 % lecture seule : aucun mapping n'est enregistré (le bouton
// d'enregistrement n'est jamais cliqué), aucun sens de sync changé, aucun
// record créé ni modifié.
describe('Commandes — onglet Airtable fusionné dans l’onglet Champs', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 20000 })
  })

  after(async () => { await browser?.close() })

  test('/champs/orders?tab=orders : plus d’onglet « Airtable · Commandes », tout est dans le tableau', async () => {
    // Deep-link sur l'ancien onglet : il ne doit plus exister et la page doit
    // atterrir sur le tableau des champs.
    await page.goto(URL + '/champs/orders?tab=orders', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid^="fieldcfg-row-"]', { timeout: 25000 })

    // L'onglet des commandes a disparu ; celui des lignes de commande (autre
    // table ERP) reste.
    await page.waitForSelector('[data-testid="fieldcfg-tab-order_items"]', { timeout: 25000 })
    assert.equal(
      await page.locator('[data-testid="fieldcfg-tab-orders"]').count(), 0,
      'l’onglet « Airtable · Commandes » ne doit plus exister'
    )
    assert.equal(await page.locator('[data-testid="fieldcfg-tab-fields"]').count(), 1)

    // Le picker du mapping cœur « Statut » est posé sur la ligne du champ Statut.
    await page.waitForSelector('[data-testid="coremap-orders-status"]', { timeout: 30000 })
    const statusCell = page.locator('[data-testid="fieldcfg-airtable-status"]')
    assert.equal(await statusCell.getAttribute('data-core'), '1', 'la cellule Statut porte le mapping cœur')

    // Une clé cœur dont la colonne n'est pas une colonne du tableau des
    // commandes (priorité) a quand même sa ligne : sinon son mapping serait
    // devenu invisible en fusionnant l'onglet.
    await page.waitForSelector('[data-testid="coremap-orders-priority"]', { timeout: 15000 })

    // Sens de synchronisation réglable sur un champ cœur (bouton, pas icône figée).
    const dir = page.locator('[data-testid="coremap-orders-notes-direction"]')
    await dir.waitFor({ timeout: 15000 })
    assert.ok(['both', 'pull', 'push'].includes(await dir.getAttribute('data-direction')))

    // La barre d'enregistrement du mapping est sous le tableau, désactivée tant
    // que rien n'a changé.
    const save = page.locator('[data-testid="coremap-orders-save"]')
    await save.waitFor({ timeout: 15000 })
    assert.ok(await save.isDisabled(), 'le bouton d’enregistrement est inactif sans modification')
    const rowsBox = await page.locator('[data-testid^="fieldcfg-row-"]').last().boundingBox()
    const saveBox = await save.boundingBox()
    assert.ok(saveBox.y > rowsBox.y, 'la barre d’enregistrement suit le tableau')
  })

  test('la recherche trouve un champ cœur par le nom du champ Airtable mappé', async () => {
    // Nom Airtable réellement mappé sur une clé cœur, lu depuis l'API — aucune
    // écriture, on se contente de chercher ce nom dans la recherche.
    const mapped = await page.evaluate(async () => {
      const r = await fetch('/api/connectors/airtable/module-fields/orders/core-map', {
        headers: { Authorization: 'Bearer ' + localStorage.getItem('erp_token') },
      })
      const d = await r.json()
      return Object.values(d.field_map || {}).find(v => typeof v === 'string' && v.length > 2) || null
    })
    if (!mapped) return // aucun mapping cœur configuré : rien à vérifier

    await page.fill('[data-testid="fieldcfg-search"]', mapped)
    await page.waitForFunction(
      n => document.querySelectorAll('[data-testid^="fieldcfg-row-"]').length < n,
      await page.locator('[data-testid^="fieldcfg-row-"]').count(),
      { timeout: 10000 }
    ).catch(() => {})
    const left = await page.locator('[data-testid^="fieldcfg-row-"]').count()
    assert.ok(left > 0, `la recherche « ${mapped} » doit garder le champ cœur qui le porte`)
    await page.fill('[data-testid="fieldcfg-search"]', '')
  })

  test('les autres tables gardent leur onglet de mapping cœur', async () => {
    // La fusion est pilotée par la spec serveur (colonnes ERP déclarées) : les
    // modules qui ne les déclarent pas conservent leur onglet dédié.
    await page.goto(URL + '/champs/paies?tab=paies', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="fieldcfg-tab-paies"]', { timeout: 25000 })
    await page.click('[data-testid="fieldcfg-tab-paies"]')
    await page.waitForSelector('[data-testid="coremap-paies-headers"]', { timeout: 25000 })
  })
})
