const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Détails de sync (type de sync de la table) déplacés de la barre d'outils des
// vues vers les modales de mapping de champs (signalement /factures) :
//   - encadré « Synchronisation des données » en tête des modales Sync Stripe
//     et Sync Airtable, détaillant chaque source et son déclenchement ;
//   - chaque modale ne montre QUE son propre connecteur : la modale Stripe
//     n'affiche que les sources Stripe, la modale Airtable que les sources
//     Airtable (la table factures est alimentée par les deux) ;
//   - l'ancien badge « Sync : … » de la barre d'outils n'existe plus.
// Lecture seule : aucune modale n'est enregistrée, aucun record créé/modifié.
// Ouvre la modale « Configuration des champs » (bouton de la barre d'outils de
// la DataTable, présent sur toutes les pages) puis l'onglet Airtable demandé.
async function openFieldConfig(page, moduleKey) {
  await page.click('button:has-text("Configurer les champs")')
  await page.waitForSelector(`[data-testid="fieldcfg-tab-${moduleKey}"]`, { timeout: 15000 })
  await page.click(`[data-testid="fieldcfg-tab-${moduleKey}"]`)
}

describe('Détails de sync dans les modales de mapping de champs', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => {
    await browser?.close()
  })

  test('/factures — la modale Sync Stripe affiche les détails de sync de la table', async () => {
    await page.goto(URL + '/factures', { waitUntil: 'domcontentloaded' })
    await page.click('[data-testid="factures-stripe-map-open"]')
    const details = page.locator('[data-testid="sync-details-factures"]')
    await details.waitFor({ timeout: 15000 })
    const text = await details.innerText()
    assert.match(text, /Synchronisation des données/i)
    assert.match(text, /Stripe/i)
    assert.match(text, /webhook/i)
    // La modale Stripe ne doit montrer QUE le connecteur Stripe — pas la source
    // Airtable (qui alimente aussi la table pour les liens projet/commande).
    assert.doesNotMatch(text, /Airtable/i)
    await page.keyboard.press('Escape')
  })

  test('/factures — la modale Sync Airtable affiche uniquement le sync Airtable', async () => {
    await page.goto(URL + '/factures', { waitUntil: 'domcontentloaded' })
    await openFieldConfig(page, 'factures')
    const details = page.locator('[data-testid="sync-details-factures"]')
    await details.waitFor({ timeout: 15000 })
    const text = await details.innerText()
    assert.match(text, /Synchronisation des données/i)
    assert.match(text, /Airtable/i)
    // La modale Airtable ne doit pas montrer la source Stripe.
    assert.doesNotMatch(text, /Stripe/i)
    await page.keyboard.press('Escape')
  })

  test('/paies — la modale de mapping Airtable affiche « manuel » (sync bouton)', async () => {
    await page.goto(URL + '/paies', { waitUntil: 'domcontentloaded' })
    await openFieldConfig(page, 'paies')
    const details = page.locator('[data-testid="sync-details-paies"]')
    await details.waitFor({ timeout: 15000 })
    const text = await details.innerText()
    assert.match(text, /manuel/i)
    assert.match(text, /Sync Airtable/i) // détail : bouton manuel de la page
    await page.keyboard.press('Escape')
  })

  test('le badge « Sync : … » n\'apparaît plus dans la barre d\'outils des vues', async () => {
    await page.goto(URL + '/factures', { waitUntil: 'domcontentloaded' })
    // Attendre que la barre d'outils soit rendue (compteur de lignes présent)…
    await page.locator('text=/\\d+ lignes?/').first().waitFor({ timeout: 15000 })
    // …puis vérifier l'absence du badge.
    assert.strictEqual(await page.locator('[data-testid="sync-mode-badge"]').count(), 0)
  })
})
