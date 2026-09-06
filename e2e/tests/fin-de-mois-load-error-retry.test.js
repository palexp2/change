// Écritures de fin de mois — la page doit s'ouvrir, et un échec de chargement
// doit rester rattrapable.
//
// Le bug signalé : « la section n'est pas accessible, il y a un message
// d'erreur quand je l'ouvre ». La page ne chargeait qu'une seule fois ; si
// l'appel ratait (erp-server en train de redémarrer → 502 nginx, blip réseau),
// elle restait bloquée sur un bandeau rouge, sans reprise possible autrement
// qu'un F5 manuel. Elle retente maintenant toute seule une fois, puis offre un
// bouton « Réessayer ».
//
// Lecture seule : aucun record créé, aucune config écrasée → pas de cleanup.

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
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 20000 })
}

describe('Écritures de fin de mois — ouverture et reprise après erreur', () => {
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

  test('la page s\'ouvre depuis le menu Espace finance et affiche ses écritures', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('nav button:has-text("Comptabilité")', { timeout: 20000 })
    await page.click('nav button:has-text("Comptabilité")')
    await page.click('[data-testid="nav-flyout-trigger"]')
    await page.locator('[data-testid="nav-flyout-panel"]').waitFor({ state: 'visible', timeout: 10000 })
    await page.getByRole('link', { name: 'Écritures de fin de mois', exact: true }).first().click()

    await page.waitForURL(u => u.toString().endsWith('/erp/fin-de-mois'), { timeout: 15000 })
    await page.locator('h2:has-text("Heures R&D du mois")').waitFor({ state: 'visible', timeout: 30000 })
    assert.equal(await page.locator('[data-testid="load-error"]').count(), 0, 'bandeau d\'erreur affiché à l\'ouverture')
    assert.ok(await page.locator('[data-testid="month-label"]').innerText(), 'mois non affiché')
    assert.ok(
      await page.locator('h2:has-text("Provision")').count() > 0,
      'aucune carte de provision rendue',
    )
  })

  test('un échec de chargement laisse un bouton « Réessayer » qui récupère la page', async () => {
    // Toutes les tentatives échouent (la reprise automatique comprise) : on veut
    // voir le bandeau ET le bouton.
    await page.route('**/api/month-end/month/**', route =>
      route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'test' }) }))

    await page.goto(URL + '/fin-de-mois', { waitUntil: 'domcontentloaded' })
    const banner = page.locator('[data-testid="load-error"]')
    await banner.waitFor({ state: 'visible', timeout: 30000 })
    const message = await banner.innerText()
    assert.ok(/redémarre|Réessaie|Connexion/i.test(message), `message peu clair : ${message}`)
    assert.equal(await page.locator('h2:has-text("Heures R&D du mois")').count(), 0, 'contenu rendu malgré l\'échec')

    // Le serveur revient : le bouton doit suffire, sans rechargement du navigateur.
    await page.unroute('**/api/month-end/month/**')
    await page.click('[data-testid="retry-load"]')
    await page.locator('h2:has-text("Heures R&D du mois")').waitFor({ state: 'visible', timeout: 30000 })
    assert.equal(await banner.count(), 0, 'bandeau d\'erreur toujours affiché après la reprise')
  })
})
