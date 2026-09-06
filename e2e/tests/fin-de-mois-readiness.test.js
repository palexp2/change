// Écritures de fin de mois — checklist de préparation de la clôture.
//
// Renfort demandé : « rendre le système de fin de mois plus robuste ». La page
// affiche maintenant en tête une carte « Préparation de la clôture » qui
// vérifie, AVANT que le comptable clique, tout ce qui peut faire échouer un
// import ou une comptabilisation : connexions Google/QuickBooks, fraîcheur de
// la feuille de temps dans le Drive (fichier modifié après le dernier import =
// à réimporter), paies du mois pour la subvention salariale, comptes QB.
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

describe('Écritures de fin de mois — checklist de préparation', () => {
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

  test('la carte de préparation charge ses vérifications sans bloquer la page', async () => {
    await page.goto(URL + '/fin-de-mois', { waitUntil: 'domcontentloaded' })

    // Le contenu principal ne doit pas attendre les vérifications (Drive lent).
    await page.locator('h2:has-text("Heures R&D du mois")').waitFor({ state: 'visible', timeout: 30000 })
    const card = page.locator('[data-testid="readiness-card"]')
    await card.waitFor({ state: 'visible', timeout: 10000 })

    // Les vérifications finissent par arriver (la recherche Drive prend ~1 s).
    await page.locator('[data-testid^="check-"]').first().waitFor({ state: 'visible', timeout: 45000 })
    const items = page.locator('[data-testid^="check-"]')
    assert.ok(await items.count() >= 4, `seulement ${await items.count()} vérification(s) affichée(s)`)

    // Les vérifications structurelles sont toujours présentes, avec un statut valide.
    for (const key of ['check-quickbooks', 'check-google', 'check-timesheet', 'check-accounts']) {
      const item = page.locator(`[data-testid="${key}"]`)
      assert.equal(await item.count(), 1, `vérification ${key} absente`)
      const status = await item.getAttribute('data-status')
      assert.ok(['ok', 'warn', 'error'].includes(status), `${key} : statut inattendu « ${status} »`)
    }
  })

  test('la checklist coexiste avec les cartes de provisions et le total des heures', async () => {
    assert.ok(await page.locator('h2:has-text("Provision")').count() > 0, 'aucune carte de provision rendue')
    assert.ok(
      await page.locator('td:has-text("Total employés (base de la provision)")').count() === 1,
      'ligne de total des heures absente',
    )
  })

  test('changer de mois relance les vérifications pour le nouveau mois', async () => {
    const before = await page.locator('[data-testid="month-label"]').innerText()
    await page.locator('[data-testid="month-label"]').locator('..').locator('button').first().click()
    // Le mois affiché change, la carte reste et recharge ses vérifications.
    await page.waitForFunction(
      prev => document.querySelector('[data-testid="month-label"]')?.innerText !== prev,
      before,
      { timeout: 15000 },
    )
    await page.locator('[data-testid^="check-"]').first().waitFor({ state: 'visible', timeout: 45000 })
    assert.ok(await page.locator('[data-testid^="check-"]').count() >= 4, 'vérifications non rechargées après changement de mois')
  })
})
