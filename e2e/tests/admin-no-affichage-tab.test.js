// Admin — l'onglet « Affichage » (décimales par colonne) a été retiré.
//
// Demande utilisateur : « Supprimer cet onglet, on va gérer ça au niveau des
// champs. » Le réglage du nombre de décimales se fait désormais sur le champ,
// pas dans une page Admin globale.
//
// Test en LECTURE SEULE : navigation + assertions d'absence, aucun record créé
// ni configuration écrasée → rien à nettoyer.

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

describe('Admin — plus d\'onglet « Affichage »', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await login(page)
  })

  after(async () => { await browser?.close() })

  test('la barre d\'onglets d\'Admin ne propose plus « Affichage »', async () => {
    await page.goto(URL + '/admin/systeme', { waitUntil: 'networkidle' })
    await page.waitForSelector('h1:has-text("Admin")', { timeout: 10000 })

    // Les autres onglets sont bien là (preuve que la barre est rendue).
    for (const label of ['Système', 'Utilisateurs', 'Connecteurs', 'Corbeille']) {
      assert.equal(await page.locator(`button:has-text("${label}")`).count() > 0, true,
        `l'onglet « ${label} » doit rester présent`)
    }

    assert.equal(await page.getByRole('button', { name: 'Affichage', exact: true }).count(), 0,
      'l\'onglet « Affichage » ne doit plus exister dans la barre d\'onglets')
  })

  test('l\'ancienne adresse /admin/affichage retombe sur « Système » sans écran de décimales', async () => {
    await page.goto(URL + '/admin/affichage', { waitUntil: 'networkidle' })
    await page.waitForSelector('h1:has-text("Admin")', { timeout: 10000 })

    // Plus de section « Décimales d'affichage » nulle part sur la page.
    assert.equal(await page.locator('text=Décimales d\'affichage').count(), 0,
      'la section « Décimales d\'affichage » ne doit plus être rendue')

    // L'onglet actif retombe sur Système : sa carte de santé est visible.
    const systemeTab = page.getByRole('button', { name: 'Système', exact: true }).first()
    const cls = await systemeTab.getAttribute('class')
    assert.ok(cls.includes('text-brand-600'), `« Système » doit être l'onglet actif (class: ${cls})`)
  })
})
