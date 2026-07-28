const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Signalement /factures : « Je n'arrive pas à sélectionner la table Paiements
// pour faire un lookup ». Paiements est une table ENFANT de Factures
// (payments.facture_id → factures) : elle n'est donc pas atteignable via un
// Lookup (lien direct sortant), mais via un Rollup. Ce test (LECTURE SEULE, ne
// crée aucun record) vérifie que la modale « Nouveau champ » en mode Lookup
// affiche un indice mentionnant Paiements et propose de basculer en Rollup, où
// Paiements devient réellement sélectionnable.

describe('CustomFieldModal — indice Lookup → Rollup pour Paiements', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => {
    await browser?.close()
  })

  test('indice Paiements en Lookup + bascule vers Rollup', async () => {
    await page.goto(URL + '/factures', { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle')

    const plusBtn = page.locator('button[aria-label="Ajouter un champ"]').first()
    await plusBtn.waitFor({ state: 'visible', timeout: 8000 })
    await plusBtn.click()
    await page.waitForSelector('text=Nouveau champ', { timeout: 5000 })

    // Mode Lookup → l'indice apparaît et mentionne « Paiements ».
    await page.getByRole('button', { name: 'Lookup' }).click()
    const hint = page.getByTestId('cf-lookup-rollup-hint')
    await hint.waitFor({ state: 'visible', timeout: 5000 })
    const hintText = await hint.textContent()
    assert.match(hintText, /Paiements/, 'l\'indice doit mentionner la table Paiements')

    // Le sélecteur FK du Lookup n'offre PAS Paiements (aucune FK factures→payments).
    const fkOptions = await page.getByTestId('cf-lookup-fk').locator('option').allTextContents()
    assert.ok(
      !fkOptions.some(o => /payments|paiement/i.test(o)),
      'Paiements ne doit pas apparaître dans les colonnes FK du Lookup',
    )

    // Clic sur « utilisez un champ Rollup » → bascule en mode Rollup.
    await hint.getByRole('button', { name: /Rollup/ }).click()

    // En Rollup, la table liée Paiements est bien sélectionnable.
    const rollupSelect = page.locator('select').filter({ has: page.locator('option', { hasText: 'Choisir une table liée' }) }).first()
    await rollupSelect.waitFor({ state: 'visible', timeout: 5000 })
    const rollupOptions = await rollupSelect.locator('option').allTextContents()
    assert.ok(
      rollupOptions.some(o => /paiement/i.test(o)),
      'Paiements doit être sélectionnable comme table liée en Rollup',
    )

    // Fermer sans rien créer.
    await page.keyboard.press('Escape')
  })
})
